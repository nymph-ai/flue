import type { CodemodeExecutor } from '../codemode/executor.ts';
import type { CodemodeMethod } from '../codemode/host.ts';
import { type RenderFrame, requireRenderFrame } from './frame.ts';

/** Options of {@link useCodeMode}. */
export interface UseCodeModeOptions {
	/**
	 * Which methods pause the script until a person approves them. Sandbox
	 * paths (`"github.create_issue"`, `"tools.send_email"`), a whole namespace
	 * (`"github.*"`), or a predicate over each method — it sees the MCP
	 * server's annotations, so `(m) => m.annotations?.destructiveHint === true`
	 * gates every destructive MCP tool. Enforced by `@cloudflare/codemode`'s
	 * runtime: the call is logged as pending and the execution pauses durably
	 * until the question is answered (see the Code Mode guide). Default: none.
	 */
	requiresApproval?: readonly string[] | ((method: CodemodeMethod) => boolean);
	/**
	 * Where scripts run. Default: `createCodemodeExecutor({ loader: env.LOADER })`
	 * from `@flue/runtime/cloudflare/codemode` — a fresh Dynamic Worker per
	 * script with no network (`@flue/vite` adds the `LOADER` binding). Pass
	 * one to change its limits.
	 */
	executor?: CodemodeExecutor;
	/** Output budget for a script's result and console output, in tokens. Default 10 000. */
	maxOutputTokens?: number;
}

/** One render's Code Mode declaration, as the Pi registry bridge reads it. */
export type CodeModeDeclaration = Readonly<UseCodeModeOptions>;

const OPTION_KEYS = new Set<string>(['executor', 'maxOutputTokens', 'requiresApproval']);

/**
 * Declarations live beside the frame rather than on it: the frame's shape is
 * shared with every other hook, and Code Mode is read only by the Pi
 * registry bridge ({@link readCodeModeDeclaration}).
 */
const declarations = new WeakMap<RenderFrame, CodeModeDeclaration>();

/**
 * Give the model the `codemode` tool, `@cloudflare/codemode`'s runtime: it
 * writes JavaScript that finds methods with `codemode.search()` and
 * `codemode.describe()`, calls the agent's own tools as `tools.<name>(input)`
 * and every MCP server as `<server>.<method>(input)`, wraps nondeterministic
 * work in `codemode.step()`, re-runs saved snippets with `codemode.run()`,
 * and only the script's result reaches the context. Executions, approvals and
 * snippets live in the runtime's Durable Object Facet under the agent.
 *
 * ```ts
 * export function Researcher() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useMcpConnection(github);
 *   useCodeMode({ requiresApproval: ['github.create_issue'] });
 *   return 'Triage the issues.';
 * }
 * ```
 *
 * Cloudflare target only. Declared at most once per render, and read per
 * render like the other tool hooks.
 */
export function useCodeMode(options: UseCodeModeOptions = {}): void {
	const frame = requireRenderFrame('useCodeMode');
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new Error('[flue] useCodeMode() takes an options object: { requiresApproval?, executor?, maxOutputTokens? }.');
	}
	for (const key of Object.keys(options)) {
		if (!OPTION_KEYS.has(key)) {
			throw new Error(`[flue] useCodeMode() received unknown option "${key}".`);
		}
	}
	const { executor, requiresApproval } = options;
	if (
		executor !== undefined &&
		(!executor || typeof executor !== 'object' || typeof executor.execute !== 'function')
	) {
		throw new Error(
			'[flue] useCodeMode() `executor` must be an @cloudflare/codemode Executor, such as createCodemodeExecutor() from @flue/runtime/cloudflare/codemode.',
		);
	}
	if (
		requiresApproval !== undefined &&
		typeof requiresApproval !== 'function' &&
		!(
			Array.isArray(requiresApproval) &&
			requiresApproval.every((path) => typeof path === 'string' && /^[^.]+\.[^.]+$/.test(path))
		)
	) {
		throw new Error(
			'[flue] useCodeMode() `requiresApproval` must be a list of sandbox paths ("github.create_issue", "github.*") or a predicate.',
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
