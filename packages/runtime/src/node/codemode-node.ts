/**
 * Code Mode on Node: Pi's own `CodemodeSandbox` (QuickJS on a worker thread)
 * behind Flue's {@link CodemodeExecutor} port. This is the reference the
 * conformance corpus pins, so it adds nothing to Pi's behaviour.
 */
import { CodemodeSandbox, type CodemodeSandboxOptions } from '@earendil-works/pi-codemode';
import type {
	CodemodeExecutor,
	CodemodeExecutorOptions,
	CodemodeResult,
	CodemodeTool,
} from '../pi/codemode/executor.ts';

export interface NodeCodemodeExecutorOptions {
	/**
	 * Compiled `quickjs-wasi` module. Default: the file in the installed
	 * `quickjs-wasi` package. Pass it when that file is not on disk (a bundled
	 * host).
	 */
	readonly wasm?: CodemodeSandboxOptions['wasm'];
	/**
	 * Worker entry importing `@earendil-works/pi-codemode/worker`. Default: the
	 * installed package's worker file. Pass it when pi-codemode is bundled.
	 */
	readonly workerUrl?: string | URL;
}

/** Runs each script in a fresh `CodemodeSandbox` (one worker and QuickJS VM per execution). */
export class NodeCodemodeExecutor implements CodemodeExecutor {
	private readonly running = new Set<CodemodeSandbox>();
	private closed = false;

	constructor(private readonly options: NodeCodemodeExecutorOptions = {}) {}

	async execute(
		code: string,
		tools: readonly CodemodeTool[],
		options: CodemodeExecutorOptions,
	): Promise<CodemodeResult> {
		if (this.closed) throw new Error('Sandbox is closed');
		const sandbox = new CodemodeSandbox({
			tools: [...tools],
			globals: [...(options.globals ?? [])],
			timeoutMs: options.timeoutMs,
			...(options.memoryLimitBytes === undefined
				? {}
				: { memoryLimitBytes: options.memoryLimitBytes }),
			...(this.options.wasm === undefined ? {} : { wasm: this.options.wasm }),
			...(this.options.workerUrl === undefined ? {} : { workerUrl: this.options.workerUrl }),
		});
		this.running.add(sandbox);
		try {
			return await sandbox.execute(code, {
				timeoutMs: options.timeoutMs,
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.store === undefined ? {} : { store: options.store }),
			});
		} finally {
			this.running.delete(sandbox);
			await sandbox.close();
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.running].map((sandbox) => sandbox.close()));
	}
}
