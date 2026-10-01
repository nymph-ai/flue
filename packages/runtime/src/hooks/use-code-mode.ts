import type { CodemodeExecutor } from '../codemode/executor.ts';
import { type RenderFrame, requireRenderFrame } from './frame.ts';

/** Options of {@link useCodeMode}. */
export interface UseCodeModeOptions {
	/**
	 * Where scripts run: an `@cloudflare/codemode` `Executor`. On Cloudflare,
	 * `createCodemodeExecutor({ loader: env.LOADER })` from
	 * `@flue/runtime/cloudflare` — a Dynamic Worker per script, with no
	 * network (`@flue/vite` adds the `LOADER` binding when an agent calls this
	 * hook). On Node, `new NodeCodemodeExecutor()` from `@flue/runtime/node`,
	 * which isolates nothing and is for trusted local use.
	 */
	executor: CodemodeExecutor;
	/** Output budget for a script's result and console output, in tokens. Default 10 000. */
	maxOutputTokens?: number;
}

/** One render's Code Mode declaration, as the Pi registry bridge reads it. */
export type CodeModeDeclaration = Readonly<UseCodeModeOptions>;

const OPTION_KEYS = new Set<string>(['executor', 'maxOutputTokens']);

/**
 * Declarations live beside the frame rather than on it: the frame's shape is
 * shared with every other hook, and Code Mode is read only by the Pi
 * registry bridge ({@link readCodeModeDeclaration}).
 */
const declarations = new WeakMap<RenderFrame, CodeModeDeclaration>();

/**
 * Give the model the `codemode` tool: it writes JavaScript that finds methods
 * with `codemode.search()` and `codemode.describe()`, calls the agent's own
 * tools as `tools.<name>(input)` and every MCP server as
 * `<server>.<method>(input)`, loops, filters and combines their results, and
 * only the script's result reaches the context. Discovery runs inside the
 * sandbox, so a large MCP catalog costs the prompt nothing.
 *
 * ```ts
 * // Cloudflare
 * import { env } from 'cloudflare:workers';
 * import { createCodemodeExecutor } from '@flue/runtime/cloudflare';
 *
 * export function Researcher() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useMcpConnection(docs);
 *   useCodeMode({ executor: createCodemodeExecutor({ loader: env.LOADER }) });
 *   return 'Answer questions from the docs.';
 * }
 * ```
 *
 * Declared at most once per render, and read per render like the other
 * tool hooks.
 */
export function useCodeMode(options: UseCodeModeOptions): void {
	const frame = requireRenderFrame('useCodeMode');
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new Error('[flue] useCodeMode() requires an options object: { executor, ... }.');
	}
	for (const key of Object.keys(options)) {
		if (!OPTION_KEYS.has(key)) {
			throw new Error(`[flue] useCodeMode() received unknown option "${key}".`);
		}
	}
	const { executor } = options;
	if (!executor || typeof executor !== 'object' || typeof executor.execute !== 'function') {
		throw new Error(
			'[flue] useCodeMode() requires `executor`: createCodemodeExecutor() on Cloudflare or a NodeCodemodeExecutor on Node.',
		);
	}
	const { maxOutputTokens } = options;
	if (
		maxOutputTokens !== undefined &&
		(typeof maxOutputTokens !== 'number' ||
			!Number.isFinite(maxOutputTokens) ||
			maxOutputTokens <= 0)
	) {
		throw new Error('[flue] useCodeMode() maxOutputTokens must be a positive number.');
	}
	if (declarations.has(frame)) {
		throw new Error(
			'[flue] useCodeMode() was called twice in one render. An agent has one codemode tool — declare it once.',
		);
	}
	declarations.set(frame, Object.freeze({ ...options }));
}

/** The Code Mode declaration a render recorded, if any. */
export function readCodeModeDeclaration(frame: RenderFrame): CodeModeDeclaration | undefined {
	return declarations.get(frame);
}
