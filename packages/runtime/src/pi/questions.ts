/**
 * Questions parked inside Pi Durable (docs/cloudflare-native.md rule 9;
 * `questions.ts` is the seam, `entity/questions.ts` the Electric side).
 *
 * ## Where a question waits
 *
 * A tool call that needs an answer from a participant does not end its turn.
 * It creates a `flue.question` task ({@link QuestionTask}) as a child of its
 * own tool task and waits on it with `api.waitForTask` — Pi's own
 * owned-task pattern, the one `flue.delegate` uses. The Generation task is
 * already `waiting` on the tool task, so the conversation's turn stays open
 * with no model round trip, and nothing runs while the question is parked.
 *
 * Everything that survives an eviction is a Pi record:
 *
 * - the question itself, a member of the session document family
 *   {@link FlueQuestions} keyed by question id, with its status
 *   (`parked` → `answered` | `expired` | `cancelled`) and, once answered, the
 *   answer;
 * - {@link FlueQuestionIndex}: the ids still parked, with their deadlines —
 *   what listing pending questions and the timeout scan read;
 * - {@link FlueQuestionCall}, a task-scoped document of the asking tool task:
 *   that the call started, the question it waits on, and the questions whose
 *   answers it already applied.
 *
 * A Pi task cannot block on a document while it holds no invocation, so the
 * question task's one phase watches its question document and completes when
 * the answer lands. After an eviction both tasks are `running` records with
 * no invocation; the next wake (the answer's doorbell) reopens the Harness,
 * which reschedules them: the question task finds the answer and completes,
 * and the tool task — registered `replay: "safe"` — is rerun. The rerun reads
 * its {@link FlueQuestionCall} ({@link beginQuestionableCall}) and continues
 * the parked question instead of starting over; a rerun of a call that never
 * parked settles as interrupted, exactly what `replay: "unsafe"` gave these
 * tools before. An answer is marked applied before it is applied, so a crash
 * while applying it settles as interrupted rather than applying it twice.
 *
 * The live-task backstop (`host.ts`) does not wake an instance whose only
 * live work waits on parked questions ({@link onlyParked}): the answer's
 * doorbell or the question's deadline wakes it.
 *
 * ## Cost
 *
 * A parked question writes one question document, one index change, one
 * task, and the call document — a fixed number of rows however long it
 * waits and however large the history is.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import {
	defineDoc,
	defineDocFamily,
	defineTask,
	type Harness,
	type TaskId,
	type TaskInspection,
	type ToolExecutionApi,
} from '@earendil-works/pi-durable';
import type { FlueAnswer, FlueQuestion } from '../questions.ts';
import { boundedDeltas } from './docs.ts';

export const QUESTION_TASK_NAME = 'flue.question';

/** Who answered: an entity address, or a person through the HTTP route. */
export type QuestionAnswerer = { type: string; id: string };

export type FlueQuestionStatus = 'absent' | 'parked' | 'answered' | 'expired' | 'cancelled';

/** One question, keyed by its id. `absent` is the family's seed value. */
export type FlueQuestionState = {
	status: FlueQuestionStatus;
	/** The {@link FlueQuestion}, as asked. */
	question: JsonValue;
	/** The `flue.question` task the asking call waits on. */
	taskId: number | null;
	/** The asking tool task. */
	callTaskId: number | null;
	/** The conversation the asking call belongs to. */
	conversationId: number | null;
	askedAt: number;
	/** Epoch ms after which the question expires; absent: never. */
	timeoutAt?: number;
	/** Whether the `input-requested` event reached its streams. */
	published: boolean;
	/** The {@link FlueAnswer}, once answered. */
	answer?: JsonValue;
	answeredBy?: QuestionAnswerer;
	/** The inbox event that carried the answer. */
	answerEventId?: string;
	settledAt?: number;
};

export const FlueQuestions = defineDocFamily<FlueQuestionState, null>({
	kind: 'flue.questions',
	version: 1,
	checkpointWhen: boundedDeltas,
	family: true,
	scope: 'session',
	initial: () => ({
		status: 'absent',
		question: null,
		taskId: null,
		callTaskId: null,
		conversationId: null,
		askedAt: 0,
		published: false,
	}),
});

/** Parked question ids → their deadline (`0`: none). */
export type FlueQuestionIndexState = { pending: { [questionId: string]: number } };

export const FlueQuestionIndex = defineDoc<FlueQuestionIndexState>({
	kind: 'flue.question-index',
	version: 1,
	checkpointWhen: boundedDeltas,
	scope: 'session',
	initial: () => ({ pending: {} }),
});

/** What one asking tool call recorded about its questions (task-scoped). */
export type FlueQuestionCallState = {
	started: boolean;
	/** The question the call waits on (the latest it asked). */
	question: string | null;
	/** Questions whose answers the call took to apply. */
	applied: string[];
};

export const FlueQuestionCall = defineDoc<FlueQuestionCallState>({
	kind: 'flue.question-call',
	version: 1,
	checkpointWhen: boundedDeltas,
	scope: 'task',
	initial: () => ({ started: false, question: null, applied: [] }),
});

/** What a question task completes with. */
export type QuestionTaskResult = { answer: JsonValue };

type QuestionTaskInput = { questionId: string };
type QuestionTaskState = { phase: 'wait' };

type Settled =
	| { status: 'terminal'; outcome: { status: 'completed'; result: QuestionTaskResult } }
	| {
			status: 'terminal';
			outcome: { status: 'failed'; error: { message: string; detail: JsonValue } };
	  };

function settledOutcome(
	questionId: string,
	record: Readonly<FlueQuestionState> | null | undefined,
): Settled | undefined {
	switch (record?.status) {
		case 'answered':
			return {
				status: 'terminal',
				outcome: { status: 'completed', result: { answer: record.answer ?? null } },
			};
		case 'expired':
			return {
				status: 'terminal',
				outcome: {
					status: 'failed',
					error: {
						message: `Question ${questionId} expired before it was answered.`,
						detail: { type: 'question_timeout', questionId },
					},
				},
			};
		case 'cancelled':
		case 'absent':
		case undefined:
			return {
				status: 'terminal',
				outcome: {
					status: 'failed',
					error: {
						message: `Question ${questionId} was withdrawn before it was answered.`,
						detail: { type: 'question_cancelled', questionId },
					},
				},
			};
		default:
			return undefined;
	}
}

/**
 * One parked question: completes when its document is answered, fails when it
 * expires or is withdrawn. Its only phase watches the document; it holds no
 * timer and polls nothing.
 */
export const QuestionTask = defineTask<QuestionTaskInput, QuestionTaskState, QuestionTaskResult>({
	name: QUESTION_TASK_NAME,
	version: 1,
	initial: () => ({ phase: 'wait' }),
	phases: {
		wait: async (task, runtime, context) => {
			const id = task.input.questionId;
			for (;;) {
				const done = settledOutcome(id, await runtime.snapshot(FlueQuestions, id, context));
				if (done) {
					await runtime.commit(() => done, context);
					return;
				}
				const watch = await runtime.watchDoc(FlueQuestions, id, context);
				if (!watch) continue;
				try {
					await new Promise<void>((resolve, reject) => {
						const signal = runtime.signal;
						const onAbort = () => reject(signal.reason ?? new Error('aborted'));
						if (signal.aborted) return onAbort();
						signal.addEventListener('abort', onAbort, { once: true });
						const finish = () => {
							signal.removeEventListener('abort', onAbort);
							resolve();
						};
						if (settledOutcome(id, watch.value)) return finish();
						watch.start(async (value) => {
							if (settledOutcome(id, value)) finish();
						});
						void watch.closed.then(finish);
					});
				} finally {
					await watch.stop();
				}
			}
		},
	},
	abort: async (task, runtime, context) => {
		const id = task.input.questionId;
		await runtime.commit(async (tx) => {
			const record = await tx.doc(FlueQuestions, id, null);
			if (record.status === 'parked') {
				record.status = 'cancelled';
				record.settledAt = runtime.now();
				const index = await tx.doc(FlueQuestionIndex);
				delete index.pending[id];
			}
			return { status: 'terminal', outcome: { status: 'aborted' } };
		}, context);
	},
});

// ─── The asking call ────────────────────────────────────────────────────────

/** How a tool call that can ask begins (see the module documentation). */
export type QuestionableCallStart =
	/** A first run: nothing recorded before it. */
	| { readonly kind: 'first' }
	/** A rerun of a call parked on `question`: continue it. */
	| { readonly kind: 'resume'; readonly question: FlueQuestion }
	/** A rerun of a call that had not parked (or had applied its answer): it may have partially run. */
	| { readonly kind: 'interrupted'; readonly question?: FlueQuestion };

/**
 * Read (and on a first run, write) the call's {@link FlueQuestionCall}. One
 * small commit on a first run; reads only on a rerun.
 */
export async function beginQuestionableCall(
	api: ToolExecutionApi,
	context: Context,
): Promise<QuestionableCallStart> {
	const call = await api.snapshot(FlueQuestionCall, api.taskId, context);
	if (!call?.started) {
		await api.commit(async (tx) => {
			(await tx.doc(FlueQuestionCall, api.taskId)).started = true;
		}, context);
		return { kind: 'first' };
	}
	const questionId = call.question;
	if (questionId === null) return { kind: 'interrupted' };
	const record = await api.snapshot(FlueQuestions, questionId, context);
	const question = record?.question as FlueQuestion | null | undefined;
	if (!question) return { kind: 'interrupted' };
	if (call.applied.includes(questionId) || record?.status === 'cancelled') {
		return { kind: 'interrupted', question };
	}
	return { kind: 'resume', question };
}

/** Withdraw a question its call will never continue (an interrupted rerun). */
export async function cancelQuestion(
	api: ToolExecutionApi,
	questionId: string,
	now: number,
	context: Context,
): Promise<void> {
	const record = await api.snapshot(FlueQuestions, questionId, context);
	if (record?.status !== 'parked') return;
	await api.commit(async (tx) => {
		const draft = await tx.doc(FlueQuestions, questionId, null);
		if (draft.status !== 'parked') return;
		draft.status = 'cancelled';
		draft.settledAt = now;
		delete (await tx.doc(FlueQuestionIndex)).pending[questionId];
	}, context);
}

/** What {@link parkQuestion} found or did. */
export type ParkOutcome =
	| { readonly kind: 'answered'; readonly answer: FlueAnswer }
	| { readonly kind: 'expired' }
	| {
			readonly kind: 'waiting';
			readonly taskId: TaskId<QuestionTaskResult>;
			/** The `input-requested` event still has to be published. */
			readonly publish: boolean;
			readonly askedAt: number;
			readonly timeoutAt?: number;
	  };

/**
 * Park `question` under the asking tool call, idempotently on its id: a new
 * question gets its document, its index entry and its task in one commit; a
 * question parked before (a rerun asks again) is found; one already answered
 * resolves with the answer.
 */
export async function parkQuestion(
	api: ToolExecutionApi,
	question: FlueQuestion,
	options: { readonly now: number; readonly timeoutMs?: number },
	context: Context,
): Promise<ParkOutcome> {
	const found = await api.snapshot(FlueQuestions, question.id, context);
	const ownCall = found?.callTaskId === Number(api.taskId);
	if (found?.status === 'answered') {
		await recordCallQuestion(api, question.id, true, context);
		return { kind: 'answered', answer: found.answer as unknown as FlueAnswer };
	}
	if (found?.status === 'expired' && ownCall) return { kind: 'expired' };
	if (found?.status === 'parked' && found.taskId !== null) {
		await recordCallQuestion(api, question.id, false, context);
		return {
			kind: 'waiting',
			taskId: found.taskId as TaskId<QuestionTaskResult>,
			publish: !found.published,
			askedAt: found.askedAt,
			...(found.timeoutAt === undefined ? {} : { timeoutAt: found.timeoutAt }),
		};
	}
	// New, or settled under another call (a later call asking the same thing): park afresh.
	const timeoutAt =
		options.timeoutMs !== undefined && options.timeoutMs > 0
			? options.now + options.timeoutMs
			: undefined;
	const taskId = await api.commit(async (tx) => {
		const record = await tx.doc(FlueQuestions, question.id, null);
		if (record.status === 'parked' && record.taskId !== null) return record.taskId;
		const id = await tx.createTask(
			QuestionTask,
			{ questionId: question.id },
			{ ownership: { kind: 'task', taskId: api.taskId } },
		);
		record.status = 'parked';
		record.question = JSON.parse(JSON.stringify(question)) as JsonValue;
		record.taskId = Number(id);
		record.callTaskId = Number(api.taskId);
		record.conversationId = Number(api.conversationId);
		record.askedAt = options.now;
		if (timeoutAt === undefined) delete record.timeoutAt;
		else record.timeoutAt = timeoutAt;
		record.published = false;
		delete record.answer;
		delete record.answeredBy;
		delete record.answerEventId;
		delete record.settledAt;
		(await tx.doc(FlueQuestionIndex)).pending[question.id] = timeoutAt ?? 0;
		const call = await tx.doc(FlueQuestionCall, api.taskId);
		call.started = true;
		call.question = question.id;
		return Number(id);
	}, context);
	return {
		kind: 'waiting',
		taskId: taskId as unknown as TaskId<QuestionTaskResult>,
		publish: true,
		askedAt: options.now,
		...(timeoutAt === undefined ? {} : { timeoutAt }),
	};
}

async function recordCallQuestion(
	api: ToolExecutionApi,
	questionId: string,
	applied: boolean,
	context: Context,
): Promise<void> {
	const call = await api.snapshot(FlueQuestionCall, api.taskId, context);
	if (call?.question === questionId && (!applied || call.applied.includes(questionId))) return;
	await api.commit(async (tx) => {
		const draft = await tx.doc(FlueQuestionCall, api.taskId);
		draft.started = true;
		draft.question = questionId;
		if (applied && !draft.applied.includes(questionId)) draft.applied.push(questionId);
	}, context);
}

/** Record that the `input-requested` event of `questionId` reached its streams. */
export async function markPublished(
	api: ToolExecutionApi,
	questionId: string,
	context: Context,
): Promise<void> {
	await api.commit(async (tx) => {
		const record = await tx.doc(FlueQuestions, questionId, null);
		if (record.status !== 'absent') record.published = true;
	}, context);
}

/** Record that the call is about to apply the answer to `questionId` (before applying it). */
export function markApplied(
	api: ToolExecutionApi,
	questionId: string,
	context: Context,
): Promise<void> {
	return recordCallQuestion(api, questionId, true, context);
}

// ─── Answers, deadlines, listing ────────────────────────────────────────────

/** What became of one answer handed to {@link recordAnswer}. */
export type AnswerOutcome =
	| { readonly kind: 'answered' }
	| { readonly kind: 'unknown' }
	| { readonly kind: 'settled'; readonly status: FlueQuestionStatus }
	| { readonly kind: 'mismatched'; readonly expected: string };

/**
 * Settle a parked question with its answer. Anything else — an unknown id, a
 * question already answered (a duplicate or late answer), expired or
 * withdrawn, an answer of the wrong kind — changes nothing and says so.
 */
export async function recordAnswer(
	harness: Harness,
	input: {
		readonly questionId: string;
		readonly answer: FlueAnswer;
		readonly from: QuestionAnswerer;
		readonly eventId: string;
		readonly now: number;
	},
	context: Context,
): Promise<AnswerOutcome> {
	const found = await harness.snapshot(FlueQuestions, input.questionId, context);
	if (!found || found.status === 'absent') return { kind: 'unknown' };
	if (found.status !== 'parked') return { kind: 'settled', status: found.status };
	const expected = (found.question as { kind?: string } | null)?.kind ?? '';
	if (input.answer.kind !== expected) return { kind: 'mismatched', expected };
	return harness.commit(async (tx) => {
		const record = await tx.doc(FlueQuestions, input.questionId, null);
		if (record.status !== 'parked') return { kind: 'settled', status: record.status } as const;
		record.status = 'answered';
		record.answer = JSON.parse(JSON.stringify(input.answer)) as JsonValue;
		record.answeredBy = { type: input.from.type, id: input.from.id };
		record.answerEventId = input.eventId;
		record.settledAt = input.now;
		delete (await tx.doc(FlueQuestionIndex)).pending[input.questionId];
		return { kind: 'answered' } as const;
	}, context);
}

/**
 * Expire parked questions whose deadline passed; returns the next deadline
 * still ahead, if any. Reads one document when nothing is parked.
 */
export async function expireQuestions(
	harness: Harness,
	now: number,
	context: Context,
): Promise<number | undefined> {
	const index = await harness.snapshot(FlueQuestionIndex, context);
	const pending = Object.entries(index?.pending ?? {});
	const due = pending.filter(([, at]) => at > 0 && at <= now).map(([id]) => id);
	if (due.length > 0) {
		await harness.commit(async (tx) => {
			const draft = await tx.doc(FlueQuestionIndex);
			for (const id of due) {
				const record = await tx.doc(FlueQuestions, id, null);
				if (record.status === 'parked') {
					record.status = 'expired';
					record.settledAt = now;
				}
				delete draft.pending[id];
			}
		}, context);
	}
	let next: number | undefined;
	for (const [, at] of pending) {
		if (at > now && (next === undefined || at < next)) next = at;
	}
	return next;
}

/** A parked question as the listing route shows it. */
export interface PendingQuestion {
	readonly id: string;
	readonly question: FlueQuestion;
	readonly askedAt: number;
	readonly timeoutAt?: number;
	readonly conversationId: number | null;
}

/** The questions still waiting for an answer, oldest first. */
export async function listPendingQuestions(
	harness: Harness,
	context: Context,
): Promise<PendingQuestion[]> {
	const index = await harness.snapshot(FlueQuestionIndex, context);
	const found: PendingQuestion[] = [];
	for (const id of Object.keys(index?.pending ?? {})) {
		const record = await harness.snapshot(FlueQuestions, id, context);
		if (record?.status !== 'parked') continue;
		found.push({
			id,
			question: record.question as unknown as FlueQuestion,
			askedAt: record.askedAt,
			...(record.timeoutAt === undefined ? {} : { timeoutAt: record.timeoutAt }),
			conversationId: record.conversationId,
		});
	}
	return found.sort((a, b) => a.askedAt - b.askedAt);
}

/** One question's record, whatever its status (`undefined` when unknown). */
export async function readQuestion(
	harness: Harness,
	questionId: string,
	context: Context,
): Promise<Readonly<FlueQuestionState> | undefined> {
	const record = await harness.snapshot(FlueQuestions, questionId, context);
	return record && record.status !== 'absent' ? record : undefined;
}

/**
 * Conversations whose live work all waits on parked questions
 * ({@link onlyParked} per conversation).
 */
export async function parkedConversations(harness: Harness, context: Context): Promise<Set<number>> {
	const inspection = await harness.inspect(context);
	const byConversation = new Map<number, TaskInspection[]>();
	for (const task of inspection.tasks) {
		const id = Number(task.record.conversationId);
		byConversation.set(id, [...(byConversation.get(id) ?? []), task]);
	}
	const found = new Set<number>();
	if (byConversation.size === 0) return found;
	const parked = await parkedQuestionTasks(harness, context);
	if (parked.size === 0) return found;
	for (const [id, tasks] of byConversation) if (onlyParked(tasks, parked)) found.add(id);
	return found;
}

/** The `flue.question` tasks whose question is still parked (not yet answered or expired). */
export async function parkedQuestionTasks(harness: Harness, context: Context): Promise<Set<number>> {
	const index = await harness.snapshot(FlueQuestionIndex, context);
	const ids = new Set<number>();
	for (const id of Object.keys(index?.pending ?? {})) {
		const record = await harness.snapshot(FlueQuestions, id, context);
		if (record?.status === 'parked' && record.taskId !== null) ids.add(record.taskId);
	}
	return ids;
}

/**
 * Whether every live task only waits on parked questions: each is the task of
 * a question still parked ({@link parkedQuestionTasks}), or has live children
 * and all of them are. Such an instance needs no backstop wake — the answer's
 * doorbell or the question's deadline wakes it. A question already answered
 * does not count: its call is about to run again.
 */
export function onlyParked(tasks: readonly TaskInspection[], parkedTasks: ReadonlySet<number>): boolean {
	if (tasks.length === 0) return false;
	const live = new Map(tasks.map((task) => [Number(task.record.id), task]));
	const children = new Map<number, number[]>();
	for (const task of tasks) {
		const owner = task.record.owner;
		if (owner === undefined) continue;
		const list = children.get(Number(owner)) ?? [];
		list.push(Number(task.record.id));
		children.set(Number(owner), list);
	}
	const memo = new Map<number, boolean>();
	const parked = (id: number): boolean => {
		const known = memo.get(id);
		if (known !== undefined) return known;
		memo.set(id, false);
		const task = live.get(id);
		let result = false;
		if (task?.record.kind === QUESTION_TASK_NAME) result = parkedTasks.has(id);
		else {
			const below = (children.get(id) ?? []).filter((child) => live.has(child));
			result = below.length > 0 && below.every(parked);
		}
		memo.set(id, result);
		return result;
	};
	return tasks.every((task) => parked(Number(task.record.id)));
}
