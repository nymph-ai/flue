/**
 * Code Mode on Cloudflare: `@cloudflare/codemode`'s `DynamicWorkerExecutor`
 * over the Worker Loader binding (docs/cloudflare-native.md rule 7). Every
 * script runs in a fresh Dynamic Worker with `globalOutbound: null` — no
 * `fetch()`, no `connect()` — and reaches the host only through the
 * namespaces the `codemode` tool passes it, over Workers RPC.
 *
 * Limits (Workers Paid, Dynamic Workers documentation, 2026-08):
 *
 * - A Durable Object can have at most 10 distinct Dynamic Workers with
 *   requests in flight; this executor runs at most {@link DEFAULT_CONCURRENCY}
 *   scripts at once per agent instance and queues the rest.
 * - `limits.cpuMs` bounds one script's CPU (the Workers Paid ceiling is
 *   5 minutes; scripts mostly wait on the host, so the default is 30 s).
 * - `limits.subRequests` bounds its subrequests. With no network, those are
 *   its RPC calls back to the host, so the default allows 1 000 tool calls.
 * - Each distinct (id, code) pair counts as a Dynamic Worker created that
 *   day for billing; a script is a new one every time.
 */
import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import type { CodemodeExecutor } from '../codemode/executor.ts';

/** The Worker Loader binding `@flue/vite` adds when an agent calls `useCodeMode()`. */
export const CODEMODE_LOADER_BINDING = 'LOADER';

const DEFAULT_CPU_MS = 30_000;
const DEFAULT_SUBREQUESTS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;

/** The Worker Loader binding (`env.LOADER`). */
export type CodemodeWorkerLoader = WorkerLoader;

export interface CodemodeExecutorOptions {
	/** The Worker Loader binding, `env.LOADER`. */
	readonly loader: CodemodeWorkerLoader;
	/** Wall-clock deadline for one script. Default 60 000 ms. */
	readonly timeoutMs?: number;
	/** CPU limit for one script's Dynamic Worker. Default 30 000 ms. */
	readonly cpuMs?: number;
	/** Subrequest limit (host calls included) for one script. Default 1 000. */
	readonly subRequests?: number;
	/** Scripts running at once in this isolate; the platform allows 10 per Durable Object. Default 4. */
	readonly concurrency?: number;
}

/**
 * A `DynamicWorkerExecutor` for `useCodeMode()`: no outbound network, CPU and
 * subrequest limits on every Dynamic Worker, and bounded concurrency.
 */
export function createCodemodeExecutor(options: CodemodeExecutorOptions): CodemodeExecutor {
	const limits = {
		cpuMs: options.cpuMs ?? DEFAULT_CPU_MS,
		subRequests: options.subRequests ?? DEFAULT_SUBREQUESTS,
	};
	// `DynamicWorkerExecutor` has no `limits` option; the loader it is given
	// adds them to every Worker it loads.
	const loader: WorkerLoader = {
		load: (code) => options.loader.load({ ...code, limits: { ...limits, ...code.limits } }),
		get: (name, getCode) =>
			options.loader.get(name, async () => {
				const code = await getCode();
				return { ...code, limits: { ...limits, ...code.limits } };
			}),
	};
	const inner = new DynamicWorkerExecutor({
		loader,
		globalOutbound: null,
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});
	const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 10));
	let running = 0;
	const queue: (() => void)[] = [];
	return {
		async execute(code, providers, executeOptions) {
			if (running >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
			running += 1;
			try {
				return await inner.execute(code, providers, executeOptions);
			} finally {
				running -= 1;
				queue.shift()?.();
			}
		},
	};
}
