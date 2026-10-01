import type { CodemodeExecutor } from '../pi/codemode/executor.ts';
import { type RenderFrame, requireRenderFrame } from './frame.ts';

/** Options of {@link useCodeMode}. */
export interface UseCodeModeOptions {
	/**
	 * Where scripts run. On Cloudflare, a `DynamicWorkerCodemodeExecutor`
	 * over the Worker Loader binding (`@flue/runtime/cloudflare`; `@flue/vite`
	 * adds the `LOADER` binding when an agent calls this hook). On Node, a
	 * `NodeCodemodeExecutor` (`@flue/runtime/node`), which is Pi's own QuickJS
	 * sandbox.
	 */
	executor: CodemodeExecutor;
	/**
	 * Deadline for a script whose `// @options:` line sets none, in
	 * milliseconds. Default: none, as in Pi — the script runs until it settles
	 * or the call is aborted.
	 */
	timeoutMs?: number;
	/** Heap limit for a script (Node executor). Default 256 MiB, as in Pi. */
	memoryLimitBytes?: number;
	/** Output budget for a script whose `// @options:` line sets none. Default 10 000 tokens. */
	maxOutputTokens?: number;
}

/** One render's Code Mode declaration, as the Pi registry bridge reads it. */
export type CodeModeDeclaration = Readonly<UseCodeModeOptions>;

const OPTION_KEYS = new Set<string>(['executor', 'timeoutMs', 'memoryLimitBytes', 'maxOutputTokens']);

/**
 * Declarations live beside the frame rather than on it: the frame's shape is
 * shared with every other hook, and Code Mode is read only by the Pi
 * registry bridge ({@link readCodeModeDeclaration}).
 */
const declarations = new WeakMap<RenderFrame, CodeModeDeclaration>();

function assertPositive(value: unknown, field: string, allowInfinity: boolean): void {
	if (value === undefined) return;
	if (
		typeof value !== 'number' ||
		Number.isNaN(value) ||
		value <= 0 ||
		(!allowInfinity && !Number.isFinite(value))
	) {
		throw new Error(`[flue] useCodeMode() ${field} must be a positive number.`);
	}
}

/**
 * Give the model Pi's `codemode` tool: it writes JavaScript that calls the
 * agent's other tools as `await tools.<name>(args)`, loops, filters and
 * combines their results, and only the script's output reaches the context.
 * The tool's description, per-tool TypeScript declarations, source grammar
 * and result text are Pi's (`@earendil-works/pi-codemode`); the script runs
 * in the executor you pass, isolated from everything but those tools.
 *
 * ```ts
 * // Cloudflare
 * import { env } from 'cloudflare:workers';
 * import { DynamicWorkerCodemodeExecutor } from '@flue/runtime/cloudflare';
 *
 * export function Researcher() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useMcpConnection(docs);
 *   useCodeMode({ executor: new DynamicWorkerCodemodeExecutor({ loader: env.LOADER }) });
 *   return 'Answer questions from the docs.';
 * }
 * ```
 *
 * Declared at most once per render, and read per render like the other
 * tool hooks. The Pi host builds the tool from the declaration
 * ({@link readCodeModeDeclaration} → `createCodemodeToolRegistration`), with
 * the render's other tools as the ones scripts may call.
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
	if (
		!executor ||
		typeof executor !== 'object' ||
		typeof executor.execute !== 'function' ||
		typeof executor.close !== 'function'
	) {
		throw new Error(
			'[flue] useCodeMode() requires `executor`: a DynamicWorkerCodemodeExecutor on Cloudflare or a NodeCodemodeExecutor on Node.',
		);
	}
	assertPositive(options.timeoutMs, 'timeoutMs', true);
	assertPositive(options.memoryLimitBytes, 'memoryLimitBytes', false);
	assertPositive(options.maxOutputTokens, 'maxOutputTokens', false);
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
