/**
 * The Code Mode executor port (PI_UPGRADE_PLAN.md §2.6, §5).
 *
 * Pi's `CodemodeSandbox` runs scripts in QuickJS on a `node:worker_threads`
 * worker, which workerd cannot load, and Pi offers no seam to swap the host.
 * Flue therefore owns the host behind this port and keeps everything
 * model-facing from Pi: the script ABI (`tools`, `ALL_TOOLS`, `text`, `image`,
 * `exit`, `store`/`load`, `console`), the result shape ({@link CodemodeResult}),
 * the declarations and the source grammar. Implementations:
 *
 * - `NodeCodemodeExecutor` (`@flue/runtime/node`) wraps `CodemodeSandbox`.
 * - `DynamicWorkerCodemodeExecutor` (`@flue/runtime/cloudflare`) runs each
 *   script in a fresh Dynamic Worker through a Worker Loader binding.
 *
 * Both are held to one conformance corpus (`./conformance`), so a Flue
 * executor that drifts from Pi's prelude fails a test.
 *
 * The Pi imports here are type-only and erased, so this module (and the root
 * entry that re-exports its types) never loads `node:worker_threads`.
 */
import type {
	CodemodeExecuteOptions,
	CodemodeResult,
	CodemodeTool,
} from '@earendil-works/pi-codemode';

export type {
	CodemodeCall,
	CodemodeError,
	CodemodeErrorKind,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeStoreWrites,
	CodemodeTool,
	CodemodeToolContext,
} from '@earendil-works/pi-codemode';

/** Options of one {@link CodemodeExecutor.execute} call. */
export interface CodemodeExecutorOptions extends CodemodeExecuteOptions {
	/**
	 * Deadline for the whole execution, tool calls included. `Infinity`
	 * disables it; the execution then ends only when the script settles or
	 * `signal` aborts it.
	 */
	readonly timeoutMs: number;
	/**
	 * Heap limit for the script's VM. Enforced by the Node executor (QuickJS).
	 * A Dynamic Worker cannot be given a smaller heap than its isolate's
	 * platform limit, so that executor documents it as unenforced.
	 */
	readonly memoryLimitBytes?: number;
	/**
	 * Host helpers exposed as top-level functions instead of on `tools`, with
	 * `CodemodeSandbox`'s `globals` semantics: not recorded in `result.calls`.
	 */
	readonly globals?: readonly CodemodeTool[];
}

/**
 * Runs one model-written script with `tools` as its only capability.
 * `execute()` resolves with Pi's {@link CodemodeResult} and does not reject
 * for script failures; it rejects only after {@link close}.
 */
export interface CodemodeExecutor {
	execute(
		code: string,
		tools: readonly CodemodeTool[],
		options: CodemodeExecutorOptions,
	): Promise<CodemodeResult>;
	/** Abort in-flight executions (they resolve as `aborted`) and reject new ones. */
	close(): Promise<void>;
}
