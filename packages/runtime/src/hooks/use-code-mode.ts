import type { CodemodeMethod } from '../codemode/tool.ts';
import { type RenderFrame, requireRenderFrame } from './frame.ts';

/** Options of {@link useCodeMode}. */
export interface UseCodeModeOptions {
	/**
	 * Which tools wait for a person's approval before they run. Tool names as
	 * scripts call them (`"send_email"`, `"mcp__github__create_issue"`), `*`
	 * patterns (`"mcp__github__*"`), or a predicate over each tool — it sees
	 * the MCP server's annotations, so
	 * `(m) => m.annotations?.destructiveHint === true` gates every destructive
	 * MCP tool. The call waits on a question (see the Code Mode guide); a
	 * rejection rejects it inside the script. Default: none.
	 */
	requiresApproval?: readonly string[] | ((method: CodemodeMethod) => boolean);
	/** Output budget for a script's output and result, in tokens. Default 10 000. */
	maxOutputTokens?: number;
	/** Wall-clock deadline of one script, unless it sets `timeout_ms`. Default: none. */
	timeoutMs?: number;
	/** The script VM's heap limit, in bytes. Default 32 MiB. */
	memoryLimitBytes?: number;
}

/** One render's Code Mode declaration, as the Pi registry bridge reads it. */
export type CodeModeDeclaration = Readonly<UseCodeModeOptions>;

const OPTION_KEYS = new Set<string>([
	'maxOutputTokens',
	'memoryLimitBytes',
	'requiresApproval',
	'timeoutMs',
]);

/**
 * Declarations live beside the frame rather than on it: the frame's shape is
 * shared with every other hook, and Code Mode is read only by the Pi
 * registry bridge ({@link readCodeModeDeclaration}).
 */
const declarations = new WeakMap<RenderFrame, CodeModeDeclaration>();

const positive = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Give the model the `codemode` tool, Pi's Code Mode: it writes JavaScript
 * that calls the agent's own tools and every MCP server's as
 * `tools.<name>(args)` (`tools.mcp__github__list_issues(…)`), runs them
 * concurrently with `Promise.all`, keeps values with `store()`/`load()`,
 * classifies with `models.classify()`, and only the script's output reaches
 * the context. Scripts run in a QuickJS VM inside the agent itself, so a
 * script written for Pi runs here unchanged.
 *
 * ```ts
 * export function Researcher() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useMcpConnection(github);
 *   useCodeMode({ requiresApproval: ['mcp__github__create_issue'] });
 *   return 'Triage the issues.';
 * }
 * ```
 *
 * Declared at most once per render, and read per render like the other
 * tool hooks.
 */
export function useCodeMode(options: UseCodeModeOptions = {}): void {
	const frame = requireRenderFrame('useCodeMode');
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new Error(
			'[flue] useCodeMode() takes an options object: { requiresApproval?, maxOutputTokens?, timeoutMs?, memoryLimitBytes? }.',
		);
	}
	for (const key of Object.keys(options)) {
		if (!OPTION_KEYS.has(key)) {
			throw new Error(`[flue] useCodeMode() received unknown option "${key}".`);
		}
	}
	const { requiresApproval } = options;
	if (
		requiresApproval !== undefined &&
		typeof requiresApproval !== 'function' &&
		!(
			Array.isArray(requiresApproval) &&
			requiresApproval.every((name) => typeof name === 'string' && name.length > 0)
		)
	) {
		throw new Error(
			'[flue] useCodeMode() `requiresApproval` must be a list of tool names ("send_email", "mcp__github__*") or a predicate.',
		);
	}
	for (const key of ['maxOutputTokens', 'timeoutMs', 'memoryLimitBytes'] as const) {
		if (options[key] !== undefined && !positive(options[key])) {
			throw new Error(`[flue] useCodeMode() ${key} must be a positive number.`);
		}
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
