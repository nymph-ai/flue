/**
 * Where Code Mode's scripts run: `@earendil-works/pi-codemode`'s QuickJS VM,
 * in-process, in the agent's own isolate (docs/cloudflare-native.md rule 7).
 * Pi starts each VM on a `node:worker_threads` thread; a Durable Object has
 * no threads, so this module passes the sandbox a `spawn` that runs the VM
 * half (`@earendil-works/pi-codemode/vm`, the patch in
 * `patches/@earendil-works__pi-codemode@0.99.2.patch`) on the caller's own
 * thread, exchanging the same protocol messages through microtasks. Node
 * runs it the same way, so both targets run one path.
 *
 * The QuickJS module comes from {@link registerQuickJSWasm}:
 * `@flue/runtime/cloudflare/codemode` imports `quickjs-wasi/quickjs.wasm` as
 * a compiled `WebAssembly.Module` (workerd cannot compile wasm at run time)
 * and registers it; elsewhere Pi's own loader reads and compiles the file.
 *
 * A script shares its thread with the agent, so it is bounded three ways:
 *
 * - CPU: QuickJS polls an interrupt handler as it runs, and a script is
 *   stopped after {@link DEFAULT_CPU_BUDGET} polls. workerd's clock does not
 *   advance while JavaScript runs, so polls are the only measure there is.
 *   Measured (QuickJS 3.6.2): a poll comes every ~1.2 ms of a tight loop,
 *   ~7 ms of `await` churn and ~28 ms of native-heavy work (`JSON.stringify`
 *   in a loop), so the default stops the worst of those near 11 s — inside
 *   a Durable Object's 30 s CPU limit — and a tight loop within 0.5 s.
 *   Glue code that filters tool results uses a handful.
 * - Memory: the VM's heap is capped ({@link DEFAULT_MEMORY_LIMIT_BYTES});
 *   allocations beyond it fail inside the script as
 *   `InternalError: out of memory`. A Durable Object has 128 MB in all.
 * - Wall time: the script's `// @options: {"timeout_ms": …}` line, or
 *   `useCodeMode({ timeoutMs })`; none by default, as in Pi, since a script
 *   may wait on an approval for as long as a person takes.
 */
import {
	type CodemodeSpawn,
	type CodemodeWasmModule,
	loadQuickJSWasm,
} from '@earendil-works/pi-codemode';
import { crash, runCodemodeVm } from '@earendil-works/pi-codemode/vm';

/** Interrupt polls one script may use; see the module documentation. */
export const DEFAULT_CPU_BUDGET = 400;

/** The VM's heap limit. */
export const DEFAULT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

let registered: CodemodeWasmModule | undefined;

/** Install the compiled QuickJS module (`@flue/runtime/cloudflare/codemode` does, at import). */
export function registerQuickJSWasm(module: CodemodeWasmModule): void {
	registered = module;
}

/** The compiled QuickJS module: the registered one, else Pi's loader (Node). */
export function quickJSWasm(): Promise<CodemodeWasmModule> {
	if (registered) return Promise.resolve(registered);
	return loadQuickJSWasm().catch((error: unknown) => {
		throw new Error(
			`[flue] Code Mode could not load QuickJS (quickjs-wasi/quickjs.wasm): ${error instanceof Error ? error.message : String(error)}. ` +
				'On Cloudflare the generated Worker entry imports @flue/runtime/cloudflare/codemode, which provides it; ' +
				'a custom `main` must `export * from "virtual:flue/worker"` or import that module itself.',
		);
	});
}

/** One execution's in-process VM channel, and whether its CPU budget ran out. */
export interface InProcessVm {
	readonly spawn: CodemodeSpawn;
	/** True once the script was interrupted for using its whole CPU budget. */
	exhausted(): boolean;
}

/**
 * A `spawn` that runs the VM on this thread. Messages in both directions go
 * through `queueMicrotask`, so neither side is re-entered from inside the
 * other; `terminate()` drops the VM, and its wasm instance with it.
 */
export function inProcessVm(cpuBudget = DEFAULT_CPU_BUDGET): InProcessVm {
	let polls = 0;
	return {
		exhausted: () => polls > cpuBudget,
		spawn(data, events) {
			let listener: ((message: never) => void) | undefined;
			let terminated = false;
			const port = {
				post(message: unknown) {
					queueMicrotask(() => {
						if (!terminated) events.message(message);
					});
				},
				onMessage(next: (message: never) => void) {
					listener = next;
				},
			};
			runCodemodeVm(data, port as never, { shouldInterrupt: () => ++polls > cpuBudget }).catch(
				(error: unknown) => crash(port as never, error),
			);
			return {
				postMessage(message) {
					queueMicrotask(() => {
						if (!terminated) listener?.(message as never);
					});
				},
				terminate() {
					terminated = true;
				},
			};
		},
	};
}
