/**
 * Flue submissions and receipts over Pi Durable submissions
 * (PI_UPGRADE_PLAN.md §3), losslessly:
 *
 * - The Flue `submissionId` (`sub_…`, or the frozen `sub_ik_…` derivation of
 *   an idempotency key) is the Pi `requestId`, so Pi's own dedup
 *   (`submissionByRequest`) converges retries.
 * - The receipt (`flue.receipts[submissionId]`) keeps what Pi does not:
 *   the identity digest (payload-conflict 409s), `acceptedAt`, the uid echo,
 *   the submitted content (so admission can be repaired), limits, attempts
 *   and Flue's own classification.
 * - Admission is two commits because Pi's `admitSubmission` is internal and
 *   `Tx` has no inbox-aware create. Commit A checks the send condition,
 *   records birth, and writes the receipt `admitting`; commit B submits
 *   through `Conversation.submit` and marks it `admitted`. A crash between
 *   them is repaired by `repairAdmissions` (called from `wake`) or by the
 *   caller's retry — both redo B, which the request id makes idempotent.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import {
	AssistantEntry,
	type ConversationId,
	type EntryId,
	type Harness,
	ROOT_CONVERSATION_ID,
	type SubmissionId,
	type SubmissionRecord,
	ToolResultEntry,
	type UserInput,
} from '@earendil-works/pi-durable';
import {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	InvalidRequestError,
	SubmissionConflictError,
} from '../errors.ts';
import { renderSignalMessage } from '../message-rendering.ts';
import { generateInstanceUid } from '../runtime/ids.ts';
import type { DeliveredMessage, DispatchReceipt } from '../types.ts';
import {
	FlueInstance,
	FlueReceiptIndex,
	FlueReceipts,
	type FlueReceiptClassification,
	type FlueReceiptState,
	FlueSessions,
} from './docs.ts';
import { ATTACHMENT_PLACEHOLDER_PREFIX, type FlueAttachmentPort } from './hooks.ts';
import { resultFromToolDetails } from './tools.ts';

/** One Flue delivery, as the coordinators hand it to the host (§2.1). */
export interface FlueAdmission {
	/** `sub_…` or `sub_ik_…` (frozen `deriveKeyedSubmissionId`). */
	readonly submissionId: string;
	readonly kind: 'dispatch' | 'direct';
	/** Flue named session; `undefined` is the root session. */
	readonly session?: string;
	readonly message: DeliveredMessage;
	readonly initialData?: unknown;
	/** Send condition: omitted = unconditional, `null` = create-only, a string = must match. */
	readonly uid?: string | null;
	readonly acceptedAt: string;
	/** Flue join ⇒ `steer`; a queued non-join ⇒ `followUp`. */
	readonly whenBusy: 'steer' | 'followUp';
	readonly limits?: { readonly timeoutAt?: number; readonly maxAttempts?: number };
	readonly traceCarrier?: Record<string, string>;
}

/** Terminal Flue outcome of one submission (§3 settlement mapping). */
export interface FlueSettlement {
	readonly submissionId: string;
	readonly outcome: 'completed' | 'failed' | 'aborted';
	readonly answerEntryId?: number;
	/** Set when another input of the same run hosts the shared answer. */
	readonly answeredBySubmissionId?: string;
	readonly error?: { message: string; detail?: unknown };
	/** Structured result recorded by the terminating `finish` tool. */
	readonly result?: unknown;
	readonly settledAt: string;
}

/** The instance a receipt belongs to (Flue agent name + instance id). */
export interface ReceiptTarget {
	readonly type: string;
	readonly id: string;
}

export interface AdmissionOptions {
	/** Validate and parse creation data (the agent's `initialData` schema). Default: identity. */
	readonly parseInitialData?: (initialData: unknown) => unknown;
	/** Moves attachment bytes out of the canonical log; absent keeps them inline. */
	readonly attachments?: FlueAttachmentPort;
}

type AdmissionOutcome = { readonly receipt: FlueReceiptState; readonly deduplicated: boolean };

/** Detach a committed or draft document value (drafts are proxies). */
function plain<T>(value: unknown): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

// ─── Identity ────────────────────────────────────────────────────────────────

/** Canonical JSON: sorted keys, `undefined` properties dropped (= `sameSubmissionIdentity`'s `deepEquals`). */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** SHA-256 of the submission identity `{kind, agent, id, message, initialData}`. */
export async function submissionDigest(target: ReceiptTarget, admission: FlueAdmission): Promise<string> {
	const identity = canonicalJson({
		kind: admission.kind,
		agent: target.type,
		id: target.id,
		message: admission.message,
		initialData: admission.initialData,
	});
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The Pi user content of a delivered message. Signals render as Flue's
 * signal envelope; attachments become `flue-attachment:<id>` placeholders
 * when an attachment port is present (rehydrated per request by the hooks).
 */
export async function deliveredMessageContent(
	message: DeliveredMessage,
	submissionId: string,
	attachments: FlueAttachmentPort | undefined,
): Promise<UserInput> {
	if (message.kind === 'signal') {
		return [
			{
				type: 'text',
				text: renderSignalMessage({
					role: 'signal',
					type: message.type,
					content: message.body,
					...(message.attributes ? { attributes: message.attributes } : {}),
					...(message.tagName ? { tagName: message.tagName } : {}),
					timestamp: 0,
				}),
			},
		];
	}
	const content: Exclude<UserInput, string> = [{ type: 'text', text: message.body }];
	for (const [index, attachment] of (message.attachments ?? []).entries()) {
		const data = attachments
			? `${ATTACHMENT_PLACEHOLDER_PREFIX}${await attachments.put(submissionId, index, attachment)}`
			: attachment.data;
		content.push({ type: 'image', data, mimeType: attachment.mimeType });
	}
	return content;
}

// ─── Admission ───────────────────────────────────────────────────────────────

/**
 * Commit A: the send condition, birth, and the `admitting` receipt — or the
 * dedup/conflict verdict for a submission id seen before. Everything that
 * rejects throws before anything durable is written.
 */
export async function beginAdmission(
	harness: Harness,
	target: ReceiptTarget,
	admission: FlueAdmission,
	options: AdmissionOptions,
	context: Context,
): Promise<AdmissionOutcome> {
	if (typeof admission.uid === 'string' && admission.initialData !== undefined) {
		throw new InvalidRequestError({
			reason:
				'A send conditioned on an existing instance (`uid`) cannot carry `initialData` — the condition forbids creation, so the seed could never apply.',
		});
	}
	const digest = await submissionDigest(target, admission);
	const existing = await harness.snapshot(FlueReceipts, admission.submissionId, context);
	if (existing !== undefined && existing.status !== 'absent') {
		if (existing.digest !== digest) throw new SubmissionConflictError({ submissionId: admission.submissionId });
		return { receipt: existing as FlueReceiptState, deduplicated: true };
	}
	const content = await deliveredMessageContent(admission.message, admission.submissionId, options.attachments);
	return harness.commit(async (tx) => {
		const receipt = await tx.doc(FlueReceipts, admission.submissionId, null);
		if (receipt.status !== 'absent') {
			// A concurrent admission of the same id won the line.
			if (receipt.digest !== digest) throw new SubmissionConflictError({ submissionId: admission.submissionId });
			return { receipt: plain<FlueReceiptState>(receipt), deduplicated: true };
		}
		const instance = await tx.doc(FlueInstance);
		const exists = instance.uid !== null;
		if (typeof admission.uid === 'string') {
			if (!exists || instance.uid !== admission.uid) throw new AgentInstanceNotFoundError({ id: target.id });
		} else if (admission.uid === null && exists) {
			throw new AgentInstanceExistsError({ id: target.id, uid: instance.uid as string });
		}
		if (!exists) {
			const parsed = (options.parseInitialData ?? ((data: unknown) => data))(admission.initialData);
			instance.uid = generateInstanceUid();
			instance.createdAt = admission.acceptedAt;
			if (parsed !== undefined) instance.initialData = { value: parsed as JsonValue };
		}
		let conversationId: number = ROOT_CONVERSATION_ID;
		if (admission.session !== undefined) {
			const sessions = await tx.doc(FlueSessions);
			const known = sessions.sessions[admission.session];
			if (known !== undefined) conversationId = known;
			else {
				conversationId = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id;
				sessions.sessions[admission.session] = conversationId;
			}
		}
		receipt.status = 'admitting';
		receipt.conversationId = conversationId;
		if (admission.session !== undefined) receipt.session = admission.session;
		receipt.kind = admission.kind;
		receipt.digest = digest;
		receipt.acceptedAt = admission.acceptedAt;
		receipt.uid = instance.uid as string;
		receipt.whenBusy = admission.whenBusy;
		receipt.content = content as JsonValue;
		receipt.attempts = 1;
		if (admission.limits?.timeoutAt !== undefined) receipt.timeoutAt = admission.limits.timeoutAt;
		if (admission.limits?.maxAttempts !== undefined) receipt.maxAttempts = admission.limits.maxAttempts;
		if (admission.traceCarrier !== undefined) receipt.traceCarrier = { ...admission.traceCarrier };
		const index = await tx.doc(FlueReceiptIndex);
		if (!index.admitting.includes(admission.submissionId)) index.admitting.push(admission.submissionId);
		return { receipt: plain<FlueReceiptState>(receipt), deduplicated: false };
	}, context);
}

/**
 * Commit B: submit into the Pi inbox under `requestId = submissionId`, then
 * mark the receipt `admitted`. Idempotent: a repeat finds Pi's submission by
 * request id and rewrites the same marks.
 */
export async function completeAdmission(
	harness: Harness,
	submissionId: string,
	context: Context,
): Promise<FlueReceiptState> {
	const receipt = await harness.snapshot(FlueReceipts, submissionId, context);
	if (receipt === undefined || receipt.status === 'absent') {
		throw new Error(`[flue] invariant: submission ${submissionId} has no receipt to admit.`);
	}
	if (receipt.status === 'admitted') return receipt as FlueReceiptState;
	const conversation = await harness.conversation(receipt.conversationId as ConversationId, context);
	if (!conversation) {
		throw new Error(`[flue] invariant: receipt ${submissionId} names a missing conversation.`);
	}
	const submission = await conversation.submit(
		{
			type: 'input',
			content: receipt.content as UserInput,
			requestId: submissionId,
			whenBusy: receipt.whenBusy,
		},
		context,
	);
	return harness.commit(async (tx) => {
		const record = await tx.doc(FlueReceipts, submissionId, null);
		record.status = 'admitted';
		record.piSubmissionId = submission.id;
		const index = await tx.doc(FlueReceiptIndex);
		const at = index.admitting.indexOf(submissionId);
		if (at !== -1) index.admitting.splice(at, 1);
		index.live[submissionId] = submission.id;
		index.byPiSubmission[String(submission.id)] = submissionId;
		return plain<FlueReceiptState>(record);
	}, context);
}

/** Admit one Flue delivery: commit A, then commit B (also on a dedup that found it `admitting`). */
export async function admitSubmission(
	harness: Harness,
	target: ReceiptTarget,
	admission: FlueAdmission,
	options: AdmissionOptions,
	context: Context,
): Promise<DispatchReceipt> {
	const { receipt, deduplicated } = await beginAdmission(harness, target, admission, options, context);
	if (receipt.status === 'admitting') await completeAdmission(harness, admission.submissionId, context);
	return {
		submissionId: admission.submissionId,
		acceptedAt: receipt.acceptedAt,
		uid: receipt.uid,
		...(deduplicated ? { deduplicated: true as const } : {}),
	};
}

/** Redo commit B for every receipt a crash left `admitting`. Returns the repaired ids. */
export async function repairAdmissions(harness: Harness, context: Context): Promise<string[]> {
	const index = await harness.snapshot(FlueReceiptIndex, context);
	const repaired: string[] = [];
	for (const submissionId of index?.admitting ?? []) {
		await completeAdmission(harness, submissionId, context);
		repaired.push(submissionId);
	}
	return repaired;
}

// ─── Settlement ──────────────────────────────────────────────────────────────

async function piRecord(
	harness: Harness,
	piSubmissionId: number,
	context: Context,
): Promise<SubmissionRecord | undefined> {
	const submission = await harness.submission(piSubmissionId as SubmissionId, context);
	return submission?.status(context);
}

const CLASSIFICATION_MESSAGES: Record<FlueReceiptClassification, string> = {
	exceeded_timeout: 'Submission exceeded the configured timeout.',
	exhausted_retry_budget: 'Submission exceeded maximum recovery attempts.',
};

/** The structured result a terminating `finish`/`give_up` round recorded after `answer`. */
async function resultOfAnswer(
	harness: Harness,
	conversationId: ConversationId,
	answer: number,
	context: Context,
): Promise<{ result?: unknown; gaveUp?: string; settledAt?: number }> {
	const conversation = await harness.conversation(conversationId, context);
	if (!conversation) return {};
	const page = await conversation.entries({ minEntryId: answer as EntryId }, 64, undefined, context);
	const entries = [...page.items].reverse();
	const assistant = entries.find((entry) => entry.id === answer);
	const message = AssistantEntry.is(assistant) ? assistant.model?.[0] : undefined;
	const settledAt = message?.timestamp;
	if (message?.role !== 'assistant') return { ...(settledAt !== undefined ? { settledAt } : {}) };
	const calls = message.content.flatMap((part) => (part.type === 'toolCall' ? [part.id] : []));
	for (const callId of calls) {
		const entry = entries.find((candidate) => {
			const model = ToolResultEntry.is(candidate) ? candidate.model?.[0] : undefined;
			return model?.role === 'toolResult' && model.toolCallId === callId;
		});
		const result = entry?.model?.[0];
		if (result?.role !== 'toolResult' || result.isError) continue;
		const outcome = resultFromToolDetails(result.details);
		if (outcome?.type === 'finished') return { result: outcome.value, ...(settledAt ? { settledAt } : {}) };
		if (outcome?.type === 'gave_up') return { gaveUp: outcome.reason, ...(settledAt ? { settledAt } : {}) };
	}
	return settledAt !== undefined ? { settledAt } : {};
}

/**
 * The input of the same run that hosts a shared answer: the lowest Pi
 * submission id with that answer. Walks Flue receipts below `piSubmissionId`
 * newest-first and stops at the first earlier run's answer.
 */
async function answerHost(
	harness: Harness,
	piSubmissionId: number,
	answer: number,
	context: Context,
): Promise<string | undefined> {
	const index = await harness.snapshot(FlueReceiptIndex, context);
	const candidates = Object.keys(index?.byPiSubmission ?? {})
		.map(Number)
		.filter((id) => id < piSubmissionId)
		.sort((left, right) => right - left);
	let host: string | undefined;
	for (const candidate of candidates) {
		const record = await piRecord(harness, candidate, context);
		if (record?.type !== 'input' || record.status !== 'done') continue;
		if (record.answer < answer) break;
		if (record.answer === answer) host = index?.byPiSubmission[String(candidate)];
	}
	return host;
}

/** The Flue settlement of a submission, or `undefined` while it is unsettled or unknown. */
export async function readSettlement(
	harness: Harness,
	submissionId: string,
	now: () => number,
	context: Context,
): Promise<FlueSettlement | undefined> {
	const receipt = await harness.snapshot(FlueReceipts, submissionId, context);
	if (receipt?.status !== 'admitted' || receipt.piSubmissionId === undefined) return undefined;
	const record = await piRecord(harness, receipt.piSubmissionId, context);
	if (!record || (record.status !== 'done' && record.status !== 'unanswered')) return undefined;
	const fallbackAt = new Date(now()).toISOString();
	if (receipt.classification !== undefined) {
		return {
			submissionId,
			outcome: 'failed',
			error: { message: CLASSIFICATION_MESSAGES[receipt.classification], detail: { reason: receipt.classification } },
			settledAt: fallbackAt,
		};
	}
	if (record.status === 'unanswered') {
		return record.reason === 'aborted'
			? { submissionId, outcome: 'aborted', settledAt: fallbackAt }
			: {
					submissionId,
					outcome: 'failed',
					error: {
						message: `Submission ended without an answer: ${record.reason}`,
						...(record.detail !== undefined ? { detail: record.detail } : {}),
					},
					settledAt: fallbackAt,
				};
	}
	if (record.type !== 'input') return undefined;
	const conversationId = receipt.conversationId as ConversationId;
	const found = await resultOfAnswer(harness, conversationId, record.answer, context);
	const host = await answerHost(harness, receipt.piSubmissionId, record.answer, context);
	const settledAt = found.settledAt !== undefined ? new Date(found.settledAt).toISOString() : fallbackAt;
	if (found.gaveUp !== undefined) {
		return {
			submissionId,
			outcome: 'failed',
			answerEntryId: record.answer,
			error: { message: `The agent gave up: ${found.gaveUp}`, detail: { reason: 'gave_up' } },
			settledAt,
		};
	}
	return {
		submissionId,
		outcome: 'completed',
		answerEntryId: record.answer,
		...(host !== undefined ? { answeredBySubmissionId: host } : {}),
		...('result' in found ? { result: found.result } : {}),
		settledAt,
	};
}

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Record Flue's classification, then abort the Pi work: the queued input
 * alone when Pi can withdraw it, otherwise the conversation's run.
 */
export async function classifyAndAbort(
	harness: Harness,
	submissionId: string,
	classification: FlueReceiptClassification,
	context: Context,
): Promise<void> {
	const receipt = await harness.commit(async (tx) => {
		const record = await tx.doc(FlueReceipts, submissionId, null);
		if (record.classification === undefined) record.classification = classification;
		return plain<FlueReceiptState>(record);
	}, context);
	if (receipt.piSubmissionId === undefined) return;
	const outcome = await harness.abortSubmission(receipt.piSubmissionId as SubmissionId, context);
	if (outcome === 'already_placed') {
		const conversation = await harness.conversation(receipt.conversationId as ConversationId, context);
		await conversation?.abort(context);
	}
}

/** Live receipts: admitted, still in the index. Settled ones leave the index here. */
export async function liveReceipts(
	harness: Harness,
	context: Context,
): Promise<{ submissionId: string; receipt: FlueReceiptState }[]> {
	const index = await harness.snapshot(FlueReceiptIndex, context);
	const live: { submissionId: string; receipt: FlueReceiptState }[] = [];
	const settled: string[] = [];
	for (const [submissionId, piSubmissionId] of Object.entries(index?.live ?? {})) {
		const record = await piRecord(harness, piSubmissionId, context);
		const receipt = await harness.snapshot(FlueReceipts, submissionId, context);
		if (!record || !receipt || record.status === 'done' || record.status === 'unanswered') {
			settled.push(submissionId);
			continue;
		}
		live.push({ submissionId, receipt: receipt as FlueReceiptState });
	}
	if (settled.length > 0) {
		await harness.commit(async (tx) => {
			const draft = await tx.doc(FlueReceiptIndex);
			for (const submissionId of settled) delete draft.live[submissionId];
		}, context);
	}
	return live;
}

/** Abort live submissions past their `timeoutAt`; returns the earliest pending deadline. */
export async function enforceTimeouts(
	harness: Harness,
	now: number,
	context: Context,
): Promise<number | undefined> {
	let next: number | undefined;
	for (const { submissionId, receipt } of await liveReceipts(harness, context)) {
		if (receipt.timeoutAt === undefined || receipt.classification !== undefined) continue;
		if (receipt.timeoutAt <= now) await classifyAndAbort(harness, submissionId, 'exceeded_timeout', context);
		else next = next === undefined ? receipt.timeoutAt : Math.min(next, receipt.timeoutAt);
	}
	return next;
}

/**
 * Count one attempt for every submission a (re)opened Harness finds live —
 * the Flue attempt budget — and end those that exhausted it.
 */
export async function countAttempts(harness: Harness, context: Context): Promise<void> {
	for (const { submissionId, receipt } of await liveReceipts(harness, context)) {
		if (receipt.classification !== undefined) continue;
		const attempts = await harness.commit(async (tx) => {
			const record = await tx.doc(FlueReceipts, submissionId, null);
			record.attempts += 1;
			return record.attempts;
		}, context);
		if (receipt.maxAttempts !== undefined && attempts > receipt.maxAttempts) {
			await classifyAndAbort(harness, submissionId, 'exhausted_retry_budget', context);
		}
	}
}
