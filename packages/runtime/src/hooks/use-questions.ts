import { type RenderFrame, requireRenderFrame } from './frame.ts';

/** An entity address: an agent name and instance id, or any participant's inbox. */
export interface QuestionResponder {
	readonly type: string;
	readonly id: string;
}

/** Options of {@link useQuestions}. */
export interface UseQuestionsOptions {
	/**
	 * Also deliver every question to this entity's inbox: another agent (it
	 * receives the question as a message and answers with its
	 * `answer_question` tool), or a person's inbox stream a UI reads. Every
	 * question is always published on this agent's own
	 * `flue/v1/{type}/{id}/questions` stream.
	 */
	responder?: QuestionResponder;
	/**
	 * Expire a question nobody answered after this many milliseconds: the
	 * asking call then fails (Code Mode rejects the paused execution; the MCP
	 * call fails). The Durable Object alarm fires at the deadline. Default:
	 * questions wait until answered.
	 */
	timeoutMs?: number;
}

/** One render's question settings, as the entity question handler reads them. */
export type QuestionsDeclaration = Readonly<UseQuestionsOptions>;

const OPTION_KEYS = new Set<string>(['responder', 'timeoutMs']);

const declarations = new WeakMap<RenderFrame, QuestionsDeclaration>();

/**
 * Configure where this agent's questions go. A question is what a Code Mode
 * approval (`useCodeMode({ requiresApproval })`) or an MCP server's
 * `input_required` (an elicitation) needs from a participant: the asking call
 * waits, durably, while the question is published as an `input-requested`
 * event, and continues when an `input-answered` event arrives in the agent's
 * inbox (docs/cloudflare-native.md rule 9).
 *
 * ```ts
 * export function Deployer() {
 *   useMcpConnection(ops);
 *   useCodeMode({ requiresApproval: ['ops.deploy'] });
 *   useQuestions({ responder: { type: 'reviewer', id: 'oncall' }, timeoutMs: 3_600_000 });
 *   return 'Deploy what you are asked to.';
 * }
 * ```
 *
 * Questions need entity streams (Electric); without `useQuestions()` they
 * still go to the questions stream, and wait without a deadline. Declared at
 * most once per render.
 */
export function useQuestions(options: UseQuestionsOptions = {}): void {
	const frame = requireRenderFrame('useQuestions');
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new Error('[flue] useQuestions() takes an options object: { responder?, timeoutMs? }.');
	}
	for (const key of Object.keys(options)) {
		if (!OPTION_KEYS.has(key)) throw new Error(`[flue] useQuestions() received unknown option "${key}".`);
	}
	const { responder, timeoutMs } = options;
	if (
		responder !== undefined &&
		(typeof responder !== 'object' ||
			responder === null ||
			typeof responder.type !== 'string' ||
			responder.type.length === 0 ||
			typeof responder.id !== 'string' ||
			responder.id.length === 0)
	) {
		throw new Error('[flue] useQuestions() `responder` must be { type, id } with non-empty strings.');
	}
	if (
		timeoutMs !== undefined &&
		(typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
	) {
		throw new Error('[flue] useQuestions() `timeoutMs` must be a positive number of milliseconds.');
	}
	if (declarations.has(frame)) {
		throw new Error('[flue] useQuestions() was called twice in one render; declare it once.');
	}
	declarations.set(
		frame,
		Object.freeze({
			...(responder ? { responder: Object.freeze({ type: responder.type, id: responder.id }) } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		}),
	);
}

/** The question settings a render recorded, if any. */
export function readQuestionsDeclaration(frame: RenderFrame): QuestionsDeclaration | undefined {
	return declarations.get(frame);
}
