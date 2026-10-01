/**
 * Code Mode on Node: `@cloudflare/codemode`'s `Executor` contract over a
 * `node:vm` context inside a `worker_threads` worker.
 *
 * This is NOT a security boundary. `node:vm` shares one V8 isolate with the
 * code that creates it, and a script can climb out of a context (through any
 * host object's constructor chain) to the worker's globals and from there to
 * `require`. The worker bounds memory and the deadline terminates runaway
 * loops; nothing else is enforced. Use it for trusted, local work — the
 * Cloudflare target's Dynamic Worker executor is the sandbox.
 *
 * The ABI matches the Dynamic Worker executor's: every provider is a global
 * whose methods call back to the host, `console.*` is captured, and the
 * script's settled value (or error message) is the result.
 */
import { Worker } from 'node:worker_threads';
import type {
	CodemodeExecuteResult,
	CodemodeExecutor,
	CodemodeProvider,
} from '../codemode/executor.ts';
import { registerCodemodeModule } from '../codemode/catalog.ts';
import { toIdentifier } from '../codemode/identifiers.ts';
import { installCloudflareWorkersShim } from './cloudflare-workers-shim.ts';

installCloudflareWorkersShim();
registerCodemodeModule(() => import('@cloudflare/codemode'));

export interface NodeCodemodeExecutorOptions {
	/** Deadline for one script, tool calls included. Default 60 000 ms. */
	readonly timeoutMs?: number;
	/** Heap limit of the worker running the script. Default 128 MiB. */
	readonly memoryLimitMb?: number;
}

/** Runs inside the worker. CommonJS: `eval` workers are scripts. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const pending = new Map();
let nextId = 0;
const logs = [];
const format = (args) => args.map((value) => {
	if (typeof value === 'string') return value;
	try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}).join(' ');
parentPort.on('message', (message) => {
	const entry = pending.get(message.id);
	if (!entry) return;
	pending.delete(message.id);
	if (message.error !== undefined) entry.reject(new Error(message.error));
	else entry.resolve(message.json === undefined ? message.value : JSON.parse(message.json));
});
const call = (namespace, method, args) => new Promise((resolve, reject) => {
	const id = ++nextId;
	pending.set(id, { resolve, reject });
	let payload;
	try { payload = { args: structuredClone(args) }; } catch { payload = { json: JSON.stringify(args) }; }
	parentPort.postMessage({ type: 'call', id, namespace, method, ...payload });
});
const sandbox = {
	console: {
		log: (...args) => { logs.push(format(args)); },
		info: (...args) => { logs.push(format(args)); },
		debug: (...args) => { logs.push(format(args)); },
		warn: (...args) => { logs.push('[warn] ' + format(args)); },
		error: (...args) => { logs.push('[error] ' + format(args)); },
	},
};
for (const namespace of workerData.namespaces) {
	sandbox[namespace] = new Proxy({}, {
		get: (target, method) => {
			if (Object.prototype.hasOwnProperty.call(target, method)) return target[method];
			if (typeof method !== 'string' || method === 'then') return undefined;
			return (...args) => call(namespace, method, args);
		},
	});
}
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
const finish = (message) => {
	try { parentPort.postMessage({ type: 'done', logs, ...message }); }
	catch { parentPort.postMessage({ type: 'done', logs, json: JSON.stringify(message.result) }); }
};
(async () => {
	try {
		for (const prelude of workerData.preludes) vm.runInContext(prelude, context);
		const fn = vm.runInContext('(' + workerData.code + ')', context, { filename: 'codemode.js' });
		const result = await fn();
		finish({ result });
	} catch (error) {
		finish({ error: error && typeof error.message === 'string' ? error.message : String(error) });
	}
})();
`;

type HostFunction = (...args: unknown[]) => Promise<unknown>;

/** Runs each script in a fresh worker thread and `node:vm` context. Trusted code only. */
export class NodeCodemodeExecutor implements CodemodeExecutor {
	readonly #timeoutMs: number;
	readonly #memoryLimitMb: number;
	readonly #running = new Set<Worker>();

	constructor(options: NodeCodemodeExecutorOptions = {}) {
		this.#timeoutMs = options.timeoutMs ?? 60_000;
		this.#memoryLimitMb = options.memoryLimitMb ?? 128;
	}

	execute(
		code: string,
		providersOrFns: CodemodeProvider[] | Record<string, HostFunction>,
		options?: Parameters<CodemodeExecutor['execute']>[2],
	): Promise<CodemodeExecuteResult> {
		const providers: CodemodeProvider[] = Array.isArray(providersOrFns)
			? providersOrFns
			: [{ name: 'codemode', fns: providersOrFns }];
		const namespaces = new Map<string, (method: string) => HostFunction | undefined>();
		for (const provider of providers) {
			const fns = new Map<string, HostFunction>();
			for (const [name, fn] of Object.entries(provider.fns)) {
				fns.set(name, fn);
				fns.set(toIdentifier(name), fn);
			}
			namespaces.set(provider.name, (method) => fns.get(method));
		}
		for (const connector of options?.connectors ?? []) {
			namespaces.set(
				connector.name,
				(method) => (input?: unknown) => connector.binding.callTool(method, input),
			);
		}

		return new Promise<CodemodeExecuteResult>((resolve) => {
			const worker = new Worker(WORKER_SOURCE, {
				eval: true,
				workerData: {
					code,
					namespaces: [...namespaces.keys()],
					preludes: providers.flatMap((provider) => (provider.prelude ? [provider.prelude] : [])),
				},
				resourceLimits: { maxOldGenerationSizeMb: this.#memoryLimitMb },
			});
			this.#running.add(worker);
			let settled = false;
			const settle = (result: CodemodeExecuteResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.#running.delete(worker);
				void worker.terminate();
				resolve(result);
			};
			const timer = setTimeout(
				() => settle({ result: undefined, error: 'Execution timed out' }),
				this.#timeoutMs,
			);
			worker.on('message', (message: Record<string, unknown>) => {
				if (message.type === 'done') {
					const logs = (message.logs as string[] | undefined) ?? [];
					if (message.error !== undefined) {
						settle({ result: undefined, error: String(message.error), logs });
					} else {
						settle({
							result:
								message.json === undefined ? message.result : JSON.parse(String(message.json)),
							logs,
						});
					}
					return;
				}
				if (message.type !== 'call') return;
				const id = message.id;
				const args = (
					message.json === undefined ? message.args : JSON.parse(String(message.json))
				) as unknown[];
				const fn = namespaces.get(String(message.namespace))?.(String(message.method));
				const reply = (payload: Record<string, unknown>) => {
					if (settled) return;
					try {
						worker.postMessage({ id, ...payload });
					} catch {
						worker.postMessage({ id, json: JSON.stringify(payload.value) });
					}
				};
				if (!fn) {
					reply({
						error: `Tool "${String(message.method)}" not found in "${String(message.namespace)}"`,
					});
					return;
				}
				Promise.resolve()
					.then(() => fn(...(Array.isArray(args) ? args : [args])))
					.then(
						(value) => reply({ value }),
						(error: unknown) =>
							reply({ error: error instanceof Error ? error.message : String(error) }),
					);
			});
			worker.on('error', (error: Error) => settle({ result: undefined, error: error.message }));
			worker.on('exit', (exitCode) => {
				if (!settled)
					settle({ result: undefined, error: `The script's worker exited (code ${exitCode}).` });
			});
		});
	}

	/** Stop every running script. */
	async close(): Promise<void> {
		await Promise.all([...this.#running].map((worker) => worker.terminate()));
		this.#running.clear();
	}
}
