/**
 * Code Mode on Cloudflare: each script runs in a fresh Dynamic Worker loaded
 * through a Worker Loader binding, with no network (`globalOutbound: null`)
 * and no bindings. Its only way out is the two RPC callbacks this executor
 * passes to the Dynamic Worker's `run()`: `call` (a tool or global call, run
 * here in the host isolate) and `output` (a `text()`/`image()`/`console`
 * item, streamed so a timeout or abort keeps the output produced so far).
 *
 * The Dynamic Worker evaluates Pi's own prelude (`../pi/codemode/prelude-source.ts`,
 * vendored verbatim), so `tools`, `ALL_TOOLS`, `text`, `image`, `exit`,
 * `store`/`load` (with Pi's `MAX_STORE_*` limits) and `console` are Pi's code,
 * not a re-implementation. This module is the host half — the counterpart of
 * pi-codemode's `Execution` class: call records, the deadline, abort, and the
 * result shape. The conformance corpus checks both halves against Pi.
 *
 * Differences from Pi's QuickJS host that the platform imposes:
 *
 * - The script is a module of the Dynamic Worker (Workers forbid `eval`), so
 *   `eval`/`new Function` inside a script throw instead of evaluating.
 * - Timers, `fetch`, `connect`, `WebSocket`, `caches`, `scheduler` and
 *   `navigator` are hidden from the script, as in Pi; the rest of the
 *   workerd global scope (`URL`, `TextEncoder`, `crypto`, …) stays visible.
 * - `memoryLimitBytes` is not enforceable: the isolate's platform memory
 *   limit applies.
 * - A script that spins without yielding (`while (true) {}`) is stopped by
 *   the Dynamic Worker's `limits.cpuMs`, set to the deadline. The host
 *   reports `timeout` when its own timer fires; it has no way to preempt the
 *   Dynamic Worker's isolate beyond dropping the RPC session.
 *
 * The callbacks are passed as RPC arguments of `run()` rather than as an
 * `env.HOST` binding: a Worker Loader `env` is fixed when the Worker is
 * created, while the callbacks belong to one execution, and RPC stubs passed
 * as arguments live exactly as long as the call.
 */
import type {
	CodemodeCall,
	CodemodeError,
	CodemodeExecutor,
	CodemodeExecutorOptions,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeStoreWrites,
	CodemodeTool,
} from '../pi/codemode/executor.ts';
import { PRELUDE_SOURCE } from '../pi/codemode/prelude-source.ts';

/** The Worker Loader binding name `@flue/vite` adds when an agent uses Code Mode. */
export const CODEMODE_LOADER_BINDING = 'LOADER';

/** Compatibility date of the generated Dynamic Workers (Flue's own floor). */
const CODEMODE_COMPATIBILITY_DATE = '2026-04-01';

/** Module names inside the Dynamic Worker. The prelude drops `codemode-prelude.js` frames from stacks. */
const HARNESS_MODULE = 'codemode-prelude.js';
const SCRIPT_MODULE = 'codemode.js';

/** Globals the Pi sandbox does not have and scripts must not reach. */
const HIDDEN_GLOBALS = [
	'setTimeout',
	'setInterval',
	'clearTimeout',
	'clearInterval',
	'setImmediate',
	'clearImmediate',
	'queueMicrotask',
	'scheduler',
	'fetch',
	'connect',
	'WebSocket',
	'EventSource',
	'caches',
	'navigator',
];

/** Globals the Pi prelude defines itself; workerd's own `console` must make way. */
const PRELUDE_GLOBALS = ['console', 'tools', 'ALL_TOOLS', 'text', 'image', 'exit', 'store', 'load'];

/**
 * The Dynamic Worker's main module: Pi's prelude plus the bridge that the
 * QuickJS worker (`pi-codemode/src/runtime/worker.ts`) implements for Pi.
 */
const DYNAMIC_WORKER_HARNESS_SOURCE = `import { WorkerEntrypoint } from "cloudflare:workers";

const PRELUDE = ${PRELUDE_SOURCE};

const setTimer = globalThis.setTimeout.bind(globalThis);

// Shadow what the prototype chain provides with an own, non-configurable
// undefined, so a script cannot delete its way back to it.
function hide(name) {
	try {
		delete globalThis[name];
	} catch {
		// Non-configurable: shadowed below or left as is.
	}
	if (name in globalThis) {
		try {
			Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
		} catch {
			// An own non-configurable global cannot be shadowed.
		}
	}
}
for (const name of ${JSON.stringify(HIDDEN_GLOBALS)}) hide(name);
// The prelude defines these itself (non-configurable); make way for it.
for (const name of ${JSON.stringify(PRELUDE_GLOBALS)}) {
	try {
		delete globalThis[name];
	} catch {
		// Left for the prelude to report.
	}
}

function describeError(error) {
	if (error instanceof Error) {
		const head = error.message ? error.name + ": " + error.message : error.name;
		const stack = typeof error.stack === "string" ? error.stack.trimEnd() : "";
		return JSON.stringify({ name: error.name, message: error.message, stack: stack || head });
	}
	return JSON.stringify({ message: String(error) });
}

export default class CodemodeEntrypoint extends WorkerEntrypoint {
	async run(input, call, output) {
		const emitted = [];
		let settle;
		const done = new Promise((resolve) => {
			settle = resolve;
		});
		let api;
		let checkQueued = false;
		// Pi's worker calls stalled() after draining the VM's job queue. A macrotask
		// runs only once every microtask has drained, which is the same point.
		const check = () => {
			if (checkQueued) return;
			checkQueued = true;
			setTimer(() => {
				checkQueued = false;
				api.stalled();
			}, 0);
		};
		const bridge = (kind, a, b, c) => {
			switch (kind) {
				case "call":
				case "global":
					call(kind === "call" ? "tool" : "global", a, b, c).then(
						(reply) => {
							api.settle(a, reply.ok, reply.payload);
							check();
						},
						(error) => {
							api.settle(a, false, error instanceof Error ? error.message : String(error));
							check();
						},
					);
					break;
				case "output":
					emitted.push(
						output(a === "image" ? { type: "image", data: b, mimeType: c } : { type: "text", text: b }),
					);
					break;
				case "done":
					settle(a ? { ok: true, value: b, writes: c } : { ok: false, error: b });
					break;
			}
		};
		api = PRELUDE(bridge, JSON.stringify(input.tools), JSON.stringify(input.globals), JSON.stringify(input.store));
		let script;
		try {
			script = (await import("./${SCRIPT_MODULE}")).default;
		} catch (error) {
			settle({ ok: false, error: describeError(error) });
		}
		if (script) {
			api.run(script);
			check();
		}
		const result = await done;
		await Promise.allSettled(emitted);
		return result;
	}
}
`;

/**
 * The script as a module. The prefix shares line 1 with the script, as in
 * Pi's worker, so line numbers in stack traces match the script as written.
 */
function codemodeScriptModule(code: string): string {
	return `export default async (tools, console) => {${code}\n};\n`;
}

/** The subset of the Worker Loader binding this executor uses. */
export interface CodemodeWorkerLoader {
	get(id: string | null, getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>): WorkerStub;
	load?(code: WorkerLoaderWorkerCode): WorkerStub;
}

export interface DynamicWorkerCodemodeExecutorOptions {
	/** The Worker Loader binding, `env.LOADER` by default in a Flue Worker. */
	readonly loader: CodemodeWorkerLoader;
	/** Compatibility date of the generated Dynamic Workers. Default {@link CODEMODE_COMPATIBILITY_DATE}. */
	readonly compatibilityDate?: string;
	/** Compatibility flags of the generated Dynamic Workers. Default none. */
	readonly compatibilityFlags?: readonly string[];
}

/** One tool of the RPC input: what the prelude needs to build `tools` and `ALL_TOOLS`. */
interface HarnessInput {
	readonly tools: { name: string; jsName: string; description: string }[];
	readonly globals: { name: string; spread: boolean }[];
	/** key → JSON text, as `store()`/`load()` read them. */
	readonly store: Record<string, string>;
}

type HarnessResult =
	| { readonly ok: true; readonly value: string | undefined; readonly writes: string }
	| { readonly ok: false; readonly error: string };

type HarnessCall = (
	target: 'tool' | 'global',
	id: number,
	name: string,
	args: string | undefined,
) => Promise<{ ok: boolean; payload: string | undefined }>;

interface CodemodeEntrypoint {
	run(
		input: HarnessInput,
		call: HarnessCall,
		output: (item: CodemodeOutputItem) => void,
	): Promise<HarnessResult>;
}

/**
 * Runs each script in a fresh Dynamic Worker. Requires a Worker Loader
 * binding (`worker_loaders` in the wrangler config; `@flue/vite` adds
 * {@link CODEMODE_LOADER_BINDING} when an agent calls `useCodeMode()`).
 * Dynamic Workers are in open beta and need the Workers Paid plan.
 */
export class DynamicWorkerCodemodeExecutor implements CodemodeExecutor {
	private readonly running = new Set<DynamicWorkerExecution>();
	private closed = false;

	constructor(private readonly options: DynamicWorkerCodemodeExecutorOptions) {
		if (!options?.loader || typeof options.loader.get !== 'function') {
			throw new Error(
				'[flue] DynamicWorkerCodemodeExecutor needs a Worker Loader binding: `new DynamicWorkerCodemodeExecutor({ loader: env.LOADER })`, ' +
					'with `"worker_loaders": [{ "binding": "LOADER" }]` in the wrangler config.',
			);
		}
	}

	execute(
		code: string,
		tools: readonly CodemodeTool[],
		options: CodemodeExecutorOptions,
	): Promise<CodemodeResult> {
		if (this.closed) return Promise.reject(new Error('Sandbox is closed'));
		const execution = new DynamicWorkerExecution(code, tools, options, this.options);
		this.running.add(execution);
		return execution.promise.finally(() => this.running.delete(execution));
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((execution) => execution.abort('Sandbox closed')));
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Pi's `toCodemodeIdentifier` (pi-codemode/src/identifier.ts), which the root entry only re-exports with the Node host. */
function toCodemodeIdentifier(name: string): string {
	let identifier = '';
	for (const char of name) {
		const valid = identifier === '' ? /^[A-Za-z_$]$/.test(char) : /^[A-Za-z0-9_$]$/.test(char);
		identifier += valid ? char : '_';
	}
	return identifier === '' ? '_' : identifier;
}

function serializeStore(store: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
	const serialized: Record<string, string> = {};
	for (const [key, value] of Object.entries(store ?? {})) {
		const json = JSON.stringify(value);
		if (json !== undefined) serialized[key] = json;
	}
	return serialized;
}

function parseStoreWrites(json: string): CodemodeStoreWrites {
	const writes: CodemodeStoreWrites = { set: {}, delete: [] };
	for (const [key, value] of JSON.parse(json) as [string, string?][]) {
		if (value === undefined) writes.delete.push(key);
		else writes.set[key] = JSON.parse(value);
	}
	return writes;
}

/**
 * V8 stacks start with the `Name: message` line the prelude also prepends
 * (QuickJS stacks list frames only), so drop the duplicate.
 */
function normalizeScriptError(error: CodemodeError): CodemodeError {
	if (!error.stack) return error;
	const lines = error.stack.split('\n');
	if (lines.length > 1 && lines[0] === lines[1]) {
		return { ...error, stack: lines.slice(1).join('\n') };
	}
	return error;
}

/**
 * A Dynamic Worker failing to load the script module (a syntax error, when
 * workerd compiles modules eagerly) surfaces as the rejected `run()` call
 * rather than inside the harness. That is still the script's fault.
 */
function loadFailure(error: unknown): CodemodeError {
	const name = error instanceof Error ? error.name : undefined;
	const message = errorMessage(error);
	if (name === 'SyntaxError' || /\bSyntaxError\b/.test(message)) {
		return {
			kind: 'script',
			name: 'SyntaxError',
			message: message.replace(/^.*?SyntaxError:\s*/, ''),
		};
	}
	return { kind: 'sandbox', ...(name === undefined ? {} : { name }), message };
}

interface PendingCall {
	readonly record: CodemodeCall | undefined;
	readonly startedAt: number;
	readonly controller: AbortController;
}

/** One script run: the host half of pi-codemode's `Execution`. */
class DynamicWorkerExecution {
	readonly promise: Promise<CodemodeResult>;
	private resolveResult!: (result: CodemodeResult) => void;
	private readonly output: CodemodeOutputItem[] = [];
	private readonly calls: CodemodeCall[] = [];
	private readonly pending = new Map<number, PendingCall>();
	private readonly tools: Map<string, CodemodeTool>;
	private readonly globals: Map<string, CodemodeTool>;
	private readonly signal: AbortSignal | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private rpc: (Promise<HarnessResult> & Partial<Disposable>) | undefined;
	private finished = false;

	constructor(
		code: string,
		tools: readonly CodemodeTool[],
		options: CodemodeExecutorOptions,
		executorOptions: DynamicWorkerCodemodeExecutorOptions,
	) {
		this.promise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
		this.tools = new Map(tools.map((tool) => [tool.name, tool]));
		this.globals = new Map((options.globals ?? []).map((global) => [global.name, global]));
		this.signal = options.signal;
		if (Number.isFinite(options.timeoutMs)) {
			this.timer = setTimeout(() => {
				this.finish({ kind: 'timeout', message: `Execution timed out after ${options.timeoutMs} ms` });
			}, options.timeoutMs);
		}
		if (options.signal) {
			if (options.signal.aborted) {
				this.onAbort();
			} else {
				options.signal.addEventListener('abort', this.onAbort, { once: true });
			}
		}
		this.start(code, tools, options, executorOptions);
	}

	abort(message: string): Promise<CodemodeResult> {
		this.finish({ kind: 'aborted', message });
		return this.promise;
	}

	private start(
		code: string,
		tools: readonly CodemodeTool[],
		options: CodemodeExecutorOptions,
		executorOptions: DynamicWorkerCodemodeExecutorOptions,
	): void {
		if (this.finished) return;
		const workerCode: WorkerLoaderWorkerCode = {
			compatibilityDate: executorOptions.compatibilityDate ?? CODEMODE_COMPATIBILITY_DATE,
			compatibilityFlags: [...(executorOptions.compatibilityFlags ?? [])],
			mainModule: HARNESS_MODULE,
			modules: {
				[HARNESS_MODULE]: DYNAMIC_WORKER_HARNESS_SOURCE,
				[SCRIPT_MODULE]: codemodeScriptModule(code),
			},
			env: {},
			globalOutbound: null,
			...(Number.isFinite(options.timeoutMs)
				? { limits: { cpuMs: Math.max(1, Math.ceil(options.timeoutMs)) } }
				: {}),
		};
		const input: HarnessInput = {
			tools: tools.map((tool) => ({
				name: tool.name,
				jsName: toCodemodeIdentifier(tool.name),
				description: tool.description ?? '',
			})),
			globals: (options.globals ?? []).map((global) => ({
				name: global.name,
				spread: global.spread === true,
			})),
			store: serializeStore(options.store),
		};
		let rpc: Promise<HarnessResult> & Partial<Disposable>;
		try {
			const loader = executorOptions.loader;
			const stub =
				typeof loader.load === 'function'
					? loader.load(workerCode)
					: loader.get(crypto.randomUUID(), () => workerCode);
			const entrypoint = stub.getEntrypoint() as unknown as CodemodeEntrypoint;
			rpc = entrypoint.run(
				input,
				(target, id, name, args) => this.handleCall(target, id, name, args),
				(item) => {
					if (!this.finished) this.output.push(item);
				},
			);
		} catch (error) {
			this.finish({ kind: 'sandbox', message: `Failed to load the Dynamic Worker: ${errorMessage(error)}` });
			return;
		}
		this.rpc = rpc;
		rpc.then(
			(result) => this.handleDone(result),
			(error) => this.finish(loadFailure(error)),
		);
	}

	private onAbort = (): void => {
		const reason = this.signal?.reason;
		this.finish({
			kind: 'aborted',
			message: reason instanceof Error ? reason.message : 'Execution aborted',
		});
	};

	private handleDone(result: HarnessResult): void {
		if (!result.ok) {
			const parsed = JSON.parse(result.error) as Omit<CodemodeError, 'kind'>;
			this.finish(normalizeScriptError({ kind: 'script', ...parsed }));
			return;
		}
		this.finish(undefined, result.value === undefined ? undefined : JSON.parse(result.value), result.writes);
	}

	private async handleCall(
		target: 'tool' | 'global',
		id: number,
		name: string,
		args: string | undefined,
	): Promise<{ ok: boolean; payload: string | undefined }> {
		// Like pi-codemode's host, nothing the Worker sends after the result counts.
		if (this.finished) return { ok: false, payload: 'Execution finished' };
		const isTool = target === 'tool';
		const record: CodemodeCall | undefined = isTool
			? { name, status: 'cancelled', durationMs: 0 }
			: undefined;
		if (record) this.calls.push(record);
		const pending: PendingCall = { record, startedAt: performance.now(), controller: new AbortController() };
		this.pending.set(id, pending);
		let status: CodemodeCall['status'];
		let reply: { ok: boolean; payload: string | undefined };
		try {
			const tool = (isTool ? this.tools : this.globals).get(name);
			if (!tool) throw new Error(`Unknown ${isTool ? 'tool' : 'global'} "${name}"`);
			const parsedArgs = args === undefined ? undefined : JSON.parse(args);
			const value = await tool.execute(parsedArgs, { signal: pending.controller.signal });
			reply = { ok: true, payload: value === undefined ? undefined : JSON.stringify(value) };
			status = 'ok';
		} catch (error) {
			reply = { ok: false, payload: errorMessage(error) };
			status = 'error';
		}
		// Already cancelled by finish(): the record keeps "cancelled".
		if (this.pending.delete(id) && record) {
			record.status = status;
			record.durationMs = performance.now() - pending.startedAt;
		}
		return reply;
	}

	private finish(error: CodemodeError | undefined, value?: unknown, writes?: string): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener('abort', this.onAbort);
		const now = performance.now();
		for (const pending of this.pending.values()) {
			if (pending.record) pending.record.durationMs = now - pending.startedAt;
			pending.controller.abort();
		}
		this.pending.clear();
		// Release the RPC session: the Dynamic Worker is not needed any more.
		try {
			this.rpc?.[Symbol.dispose]?.();
		} catch {
			// Disposal is best effort; the Worker Loader reaps idle Workers.
		}
		let result: CodemodeResult;
		if (error) {
			result = { ok: false, error, output: this.output, calls: this.calls };
		} else {
			try {
				result = {
					ok: true,
					value,
					output: this.output,
					calls: this.calls,
					storeWrites: writes === undefined ? { set: {}, delete: [] } : parseStoreWrites(writes),
				};
			} catch (parseError) {
				result = {
					ok: false,
					error: { kind: 'sandbox', message: `Invalid store writes: ${errorMessage(parseError)}` },
					output: this.output,
					calls: this.calls,
				};
			}
		}
		this.resolveResult(result);
	}
}
