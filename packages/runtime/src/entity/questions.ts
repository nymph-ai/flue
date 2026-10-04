/**
 * Questions to people are entity events (docs/cloudflare-native.md rule 9).
 *
 * The question handler every agent instance with entity streams installs
 * ({@link createEntityQuestionHandler}, the instance's `QUESTION_HANDLER`):
 *
 * 1. parks the question inside Pi Durable under the asking tool call
 *    (`pi/questions.ts` — the question document, the index and a
 *    `flue.question` task, in one commit);
 * 2. publishes ONE `input-requested` event ({@link InputRequestedEvent}) with
 *    a deterministic id derived from the question id (rule 5) to the agent's
 *    `flue/v1/{type}/{id}/questions` stream, and to the inbox of the
 *    responder `useQuestions({ responder })` names, if any;
 * 3. arms the alarm at the question's deadline when `useQuestions({ timeoutMs })`
 *    set one;
 * 4. waits on the question task. The turn stays open; nothing runs.
 *
 * The answer is an `input-answered` inbox event ({@link InputAnsweredEvent})
 * — from a person through the HTTP route, from another agent through its
 * `answer_question` tool, from anything that can append to the inbox. The
 * doorbell and the pump admit it like any inbox event (`inbox.ts`), which
 * settles the question document; the question task completes and the asking
 * call continues: Code Mode resumes the execution in its facet, the MCP client
 * re-sends the request with `inputResponses` and the byte-exact
 * `requestState`. If the instance was evicted in between, Pi reruns the call
 * and it continues from the parked question (`pi/questions.ts`).
 *
 * A duplicate or late answer, an answer to an unknown or settled question,
 * and an answer of the wrong kind change nothing and are reported.
 */
import type { JsonValue } from '@earendil-works/chord';
import { withAbortSignal } from '@earendil-works/chord/context';
import type { SettledTask } from '@earendil-works/pi-durable';
import {
	type FlueAnswer,
	type FlueQuestion,
	QuestionCancelledError,
	type QuestionHandler,
	QuestionParkedError,
	QuestionTimeoutError,
} from '../questions.ts';
import type { WakeReason } from '../pi/host.ts';
import { markApplied, markPublished, parkQuestion, type QuestionTaskResult } from '../pi/questions.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import type { EntityAddress } from './events.ts';
import { appendCreating } from './append.ts';
import { entityKey, inboxPath, questionsPath } from './paths.ts';
import type { EntityRef } from './services.ts';

/** `useQuestions()` options, as one render declared them. */
export interface QuestionSettings {
	/** Also deliver each question to this entity's inbox (an agent, or a person's inbox stream). */
	readonly responder?: EntityRef;
	/** Expire an unanswered question after this many milliseconds; the asking call then fails. */
	readonly timeoutMs?: number;
}

/** What a question publishes: on the asker's questions stream, and in the responder's inbox. */
export interface InputRequestedEvent {
	readonly type: 'flue.input-requested';
	/** `input-requested:{type}/{id}/{questionId}`: the same on every publish of this question. */
	readonly eventId: string;
	/** The asking agent. */
	readonly from: EntityAddress;
	readonly questionId: string;
	readonly question: JsonValue;
	/** One line for a person (or a model) deciding what to answer. */
	readonly summary: string;
	readonly askedAt: number;
	readonly timeoutAt?: number;
	/** Where the answer goes: an `input-answered` event on this inbox stream (log path). */
	readonly answerTo: { readonly entity: EntityAddress; readonly inbox: string };
}

/** An answer, appended to the asking agent's inbox. */
export interface InputAnsweredEvent {
	readonly type: 'flue.input-answered';
	/** The answerer's idempotency key for this answer. */
	readonly eventId: string;
	/** Who answered: an entity, or a person (`{ type: "person", id }`). */
	readonly from: EntityAddress;
	readonly questionId: string;
	readonly answer: FlueAnswer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is EntityAddress {
	return (
		isRecord(value) &&
		typeof value.type === 'string' &&
		value.type.length > 0 &&
		typeof value.id === 'string' &&
		value.id.length > 0
	);
}

/** Validate a {@link FlueAnswer}; `undefined` when it is not one. */
export function parseFlueAnswer(value: unknown): FlueAnswer | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === 'codemode-approval') {
		if (value.decision === 'approve') return { kind: 'codemode-approval', decision: 'approve' };
		if (value.decision === 'reject') {
			return {
				kind: 'codemode-approval',
				decision: 'reject',
				...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
			};
		}
		return undefined;
	}
	if (value.kind === 'mcp-input' && isRecord(value.inputResponses)) {
		return { kind: 'mcp-input', inputResponses: value.inputResponses };
	}
	return undefined;
}

/** Validate an `input-answered` inbox event. */
export function parseInputAnswered(value: unknown): InputAnsweredEvent | undefined {
	if (
		!isRecord(value) ||
		value.type !== 'flue.input-answered' ||
		typeof value.eventId !== 'string' ||
		value.eventId.length === 0 ||
		typeof value.questionId !== 'string' ||
		value.questionId.length === 0 ||
		!isAddress(value.from)
	) {
		return undefined;
	}
	const answer = parseFlueAnswer(value.answer);
	return answer
		? {
				type: 'flue.input-answered',
				eventId: value.eventId,
				from: { type: value.from.type, id: value.from.id },
				questionId: value.questionId,
				answer,
			}
		: undefined;
}

/** Validate an `input-requested` event (on a questions stream, or in a responder's inbox). */
export function parseInputRequested(value: unknown): InputRequestedEvent | undefined {
	if (
		!isRecord(value) ||
		value.type !== 'flue.input-requested' ||
		typeof value.eventId !== 'string' ||
		typeof value.questionId !== 'string' ||
		!isAddress(value.from) ||
		!isRecord(value.answerTo) ||
		!isAddress(value.answerTo.entity) ||
		typeof value.answerTo.inbox !== 'string' ||
		!isRecord(value.question)
	) {
		return undefined;
	}
	return value as unknown as InputRequestedEvent;
}

/** The deterministic id of a question's `input-requested` event (rule 5). */
export function inputRequestedEventId(asker: EntityAddress, questionId: string): string {
	return `input-requested:${entityKey(asker)}/${questionId}`;
}

function clipJson(value: unknown, max = 400): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One human-readable line (or a few) describing what a question asks. */
export function summarizeQuestion(question: FlueQuestion): string {
	if (question.kind === 'codemode-approval') {
		const actions = question.pending.map(
			(action) => `${action.connector}.${action.method}(${clipJson(action.args)})`,
		);
		return `Approve ${actions.join(', ') || 'a pending action'}? Answer {"kind":"codemode-approval","decision":"approve"} or {"kind":"codemode-approval","decision":"reject","reason":"…"}.`;
	}
	const requests = Object.entries(question.inputRequests).map(([key, raw]) => {
		const request = (raw ?? {}) as { method?: unknown; params?: Record<string, unknown> };
		const params = request.params ?? {};
		const message = typeof params.message === 'string' ? `: ${params.message}` : '';
		const schema = params.requestedSchema as { properties?: Record<string, unknown> } | undefined;
		const fields = schema?.properties ? ` (fields: ${Object.keys(schema.properties).join(', ')})` : '';
		return `"${key}" ${typeof request.method === 'string' ? request.method : 'request'}${message}${fields}`;
	});
	return `MCP server "${question.server}" needs input for ${question.method}: ${requests.join('; ')}. Answer {"kind":"mcp-input","inputResponses":{"<key>":<result>}}, e.g. {"action":"accept","content":{…}} for an elicitation.`;
}

/** Build the `input-answered` event an answer appends to the asker's inbox. */
export function inputAnsweredEvent(input: {
	readonly from: EntityAddress;
	readonly questionId: string;
	readonly answer: FlueAnswer;
	readonly eventId: string;
}): InputAnsweredEvent {
	return {
		type: 'flue.input-answered',
		eventId: input.eventId,
		from: { type: input.from.type, id: input.from.id },
		questionId: input.questionId,
		answer: JSON.parse(JSON.stringify(input.answer)) as FlueAnswer,
	};
}

/**
 * Answer a question of `asker`: append one `input-answered` event to its
 * inbox — the same path every participant's answer takes. Returns the inbox
 * offset after the event (what its doorbell rings with).
 */
export async function appendAnswer(
	log: DurableStreamLog,
	asker: EntityRef,
	input: {
		readonly from: EntityAddress;
		readonly questionId: string;
		readonly answer: FlueAnswer;
		readonly eventId: string;
	},
	signal?: AbortSignal,
): Promise<{ readonly inbox: string; readonly eventId: string }> {
	const inbox = inboxPath(asker);
	await appendCreating(log, inbox, inputAnsweredEvent(input), signal);
	return { inbox, eventId: input.eventId };
}

import type { SemanticEmitter } from '../reactor/reactor.ts';

export interface EntityQuestionHandlerOptions {
	readonly entity: EntityRef;
	readonly log: DurableStreamLog;
	/** The current render's `useQuestions()` settings. */
	readonly settings: () => QuestionSettings | undefined;
	/** Arm a wake at a question's deadline (the alarm). */
	readonly armWake: (atMs: number, reason: WakeReason) => Promise<void>;
	readonly now?: () => number;
	readonly onReport?: (error: unknown) => void;
	/** Semantic emitter for outbox-backed durable delivery. */
	readonly emitter?: SemanticEmitter;
}

const PUBLISH_ATTEMPTS = 3;

/** The instance's question handler (see the module documentation). */
export function createEntityQuestionHandler(options: EntityQuestionHandlerOptions): QuestionHandler {
	const now = options.now ?? Date.now;
	const report = options.onReport ?? (() => {});
	const self: EntityAddress = { type: options.entity.type, id: options.entity.id };

	async function publish(
		question: FlueQuestion,
		askedAt: number,
		timeoutAt: number | undefined,
		settings: QuestionSettings | undefined,
		signal: AbortSignal | undefined,
	): Promise<boolean> {
		const event: InputRequestedEvent = {
			type: 'flue.input-requested',
			eventId: inputRequestedEventId(self, question.id),
			from: self,
			questionId: question.id,
			question: JSON.parse(JSON.stringify(question)) as JsonValue,
			summary: summarizeQuestion(question),
			askedAt,
			...(timeoutAt === undefined ? {} : { timeoutAt }),
			answerTo: { entity: self, inbox: inboxPath(self) },
		};
		const targets = [questionsPath(self)];
		if (settings?.responder) targets.push(inboxPath(settings.responder));

		if (options.emitter) {
			try {
				for (const path of targets) {
					await options.emitter.emitSemantic(
						{
							id: `${event.eventId}:${path}`,
							stream: path,
							event,
						},
						{ signal, immediate: true },
					);
				}
				return true;
			} catch (error) {
				report(error);
				return false;
			}
		}

		let failure: unknown;
		for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
			try {
				for (const path of targets) await appendCreating(options.log, path, event, signal);
				return true;
			} catch (error) {
				failure = error;
				if (signal?.aborted) break;
			}
		}
		// Still parked and listed; the next run of the call publishes again.
		report(failure);
		return false;
	}

	return async (question, signal, call) => {
		if (!call) {
			throw new Error(
				`[flue] ${question.id} was asked outside a tool call; only tool calls can wait for an answer.`,
			);
		}
		const { api } = call;
		const context = signal ? withAbortSignal(signal, call.context) : call.context;
		const settings = options.settings();
		const parked = await parkQuestion(
			api,
			question,
			{
				now: now(),
				...(settings?.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
			},
			context,
		);
		if (parked.kind === 'answered') return parked.answer;
		if (parked.kind === 'expired') throw new QuestionTimeoutError(question.id);
		if (parked.publish) {
			const published = await publish(
				question,
				parked.askedAt,
				parked.timeoutAt,
				settings,
				context.abortSignal,
			);
			if (published) await markPublished(api, question.id, context);
		}
		if (parked.timeoutAt !== undefined) {
			await options.armWake(parked.timeoutAt, { kind: 'questions' });
		}
		let settled: SettledTask<QuestionTaskResult>;
		try {
			settled = await api.waitForTask(parked.taskId, context);
		} catch (error) {
			// The call ended while waiting (eviction, close, abort): the question
			// stays parked; Pi reruns the call, which continues it.
			if (context.abortSignal?.aborted || call.context.abortSignal?.aborted)
				throw new QuestionParkedError(question);
			throw error;
		}
		const outcome = settled.state.outcome;
		if (outcome.status === 'completed') {
			await markApplied(api, question.id, call.context);
			return outcome.result.answer as unknown as FlueAnswer;
		}
		if (outcome.status === 'failed') {
			const type = (outcome.error.detail as { type?: string } | undefined)?.type;
			if (type === 'question_timeout') throw new QuestionTimeoutError(question.id);
		}
		throw new QuestionCancelledError(question.id);
	};
}
