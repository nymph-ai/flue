/**
 * The executor contract Code Mode runs scripts through: structurally
 * `@cloudflare/codemode`'s `Executor`, so its `DynamicWorkerExecutor` (and any
 * executor written for it) fits, without Flue's public types depending on
 * that package's Workers-only declarations.
 */

/** One sandbox global: its methods call back to the host. */
export interface CodemodeProvider {
	readonly name: string;
	readonly fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
	/** Sandbox-side JavaScript run after the global is created. */
	readonly prelude?: string;
}

/** What a script came to: its settled value, or the error that ended it. */
export interface CodemodeExecuteResult {
	result: unknown;
	error?: string;
	logs?: string[];
}

/** Runs one model-written script with the providers as its only capability. Never rejects for script failures. */
export interface CodemodeExecutor {
	execute(
		code: string,
		providers: CodemodeProvider[],
		options?: {
			connectors?: { name: string; binding: { callTool(method: string, args: unknown): Promise<unknown> } }[];
		},
	): Promise<CodemodeExecuteResult>;
}
