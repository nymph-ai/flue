/**
 * Submission-scoped, in-process observation of an agent instance's public
 * conversation wire: settlement waits and reply reads for callers that admit
 * a submission in-process and want its outcome without a transport (the
 * CLI's `flue run`, the programmatic `init()` client). They read the same
 * projection the HTTP routes serve, through a
 * {@link ConversationProjectionSource}.
 */

import type { AgentConversationSnapshot, ConversationStreamChunk } from '../conversation-public.ts';
import type { ConversationProjectionSource } from './conversation-source.ts';

/** Terminal outcome of one submission, as recorded on the conversation stream. */
export interface SubmissionSettlement {
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
}

export interface ObserveSubmissionSettlementOptions {
	/** The instance's conversation projection. */
	source: ConversationProjectionSource;
	/** The submission whose settlement resolves the observation. */
	submissionId: string;
	/** Offset to observe from — typically the admission receipt's offset, or `-1`. */
	offset: string;
	/** Receives every projected chunk as it is durably recorded. */
	onEvent?: (chunk: ConversationStreamChunk) => void;
	/**
	 * Stops the observation: the promise rejects with the signal's reason.
	 * Cancelling an observation is purely local — it never touches the
	 * submission itself.
	 */
	signal?: AbortSignal;
}

/**
 * Observe the conversation until the given submission settles, and return
 * its settlement. Every projected chunk along the way is forwarded to
 * `onEvent`. Settlement is detected in both projected forms: the
 * `submission-settled` chunk, and a `conversation-reset` whose snapshot
 * already contains it.
 */
export async function observeSubmissionSettlement(
	options: ObserveSubmissionSettlementOptions,
): Promise<SubmissionSettlement> {
	const { source, submissionId } = options;
	let offset = options.offset;
	while (true) {
		throwIfAborted(options.signal);
		const read = await source.read(offset, {
			live: 'long-poll',
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (read === 'aborted') {
			throwIfAborted(options.signal);
			continue;
		}
		let settlement: SubmissionSettlement | undefined;
		for (const chunk of read.chunks) {
			options.onEvent?.(chunk);
			settlement ??= settlementFromChunk(chunk, submissionId);
		}
		if (settlement) return settlement;
		offset = read.nextOffset;
	}
}

/** Throw the signal's reason (default `AbortError`) once it has fired. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/**
 * Extract the given submission's settlement from one projected chunk, in both
 * projected forms (see {@link observeSubmissionSettlement}). Shared by the
 * in-process observation above and the Cloudflare client, which consumes the
 * same chunks over the agent DO's conversation read route.
 */
export function settlementFromChunk(
	chunk: ConversationStreamChunk,
	submissionId: string,
): SubmissionSettlement | undefined {
	if (chunk.type === 'submission-settled' && chunk.submissionId === submissionId) {
		return {
			outcome: chunk.outcome,
			...(chunk.error === undefined ? {} : { error: chunk.error }),
		};
	}
	if (chunk.type === 'conversation-reset') {
		return settlementFromSnapshot(chunk.snapshot, submissionId);
	}
	return undefined;
}

function settlementFromSnapshot(
	snapshot: AgentConversationSnapshot,
	submissionId: string,
): SubmissionSettlement | undefined {
	const settled = snapshot.settlements.find((entry) => entry.submissionId === submissionId);
	if (!settled) return undefined;
	return {
		outcome: settled.outcome,
		...(settled.error === undefined ? {} : { error: settled.error }),
	};
}

// ─── Submission reply ────────────────────────────────────────────────────────

/** The reply a settled submission produced, read from the history projection. */
export interface SubmissionReply {
	/** Final assistant text produced by the submission ('' when none). */
	text: string;
	/**
	 * Named client data parts (`useDataWriter`) on the reply message, keyed
	 * by part name, each in emit order.
	 */
	data: Record<string, unknown[]>;
	/** Agent-authored response metadata (`useResponseStart`/`useResponseFinish`), when present. */
	metadata?: Record<string, unknown>;
}

export interface ReadSubmissionReplyOptions {
	source: ConversationProjectionSource;
	submissionId: string;
}

/**
 * Read the reply the given submission produced: the response message stamped
 * with its submissionId, or — for a delivery that joined a busy response —
 * the response of the submission its settlement names as `answeredBy`.
 */
export async function readSubmissionReply(
	options: ReadSubmissionReplyOptions,
): Promise<SubmissionReply> {
	const head = await options.source.head();
	if (!head.snapshot) return { text: '', data: {} };
	return replyFromSnapshot(head.snapshot, options.submissionId);
}

/**
 * Extract a submission's reply from a materialized conversation snapshot.
 * Shared by {@link readSubmissionReply} and the Cloudflare client, which reads
 * the same snapshot over the agent DO's history route.
 */
export function replyFromSnapshot(
	snapshot: AgentConversationSnapshot,
	submissionId: string,
): SubmissionReply {
	const assistantMessages = snapshot.messages.filter((message) => message.role === 'assistant');
	const own = assistantMessages.filter((message) => message.submissionId === submissionId);
	let reply = own.at(-1);
	if (!reply) {
		const settlement = snapshot.settlements.find((entry) => entry.submissionId === submissionId);
		reply =
			settlement?.answeredBySubmissionId !== undefined
				? assistantMessages
						.filter((message) => message.submissionId === settlement.answeredBySubmissionId)
						.at(-1)
				: assistantMessages.at(-1);
	}
	if (!reply) return { text: '', data: {} };

	const text = reply.parts
		.filter(
			(part): part is Extract<(typeof reply.parts)[number], { type: 'text' }> =>
				part.type === 'text' && typeof part.text === 'string',
		)
		.map((part) => part.text)
		.join('\n\n');

	const data: Record<string, unknown[]> = {};
	for (const part of reply.parts) {
		if (!part.type.startsWith('data-')) continue;
		const name = part.type.slice('data-'.length);
		const values = data[name] ?? [];
		values.push((part as { data: unknown }).data);
		data[name] = values;
	}

	return {
		text,
		data,
		...(reply.metadata !== undefined ? { metadata: reply.metadata } : {}),
	};
}
