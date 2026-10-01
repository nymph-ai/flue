/**
 * The public conversation wire (`history` snapshots and `updates` chunks),
 * wire-compatible with `@flue/sdk`. Projected from Pi's commits by
 * `pi/projection.ts` and cached in the instance (`pi/conversation-cache.ts`); pre-upgrade record streams project through
 * `legacy/conversation-projection.ts`.
 */
import type { ConversationUiMessage } from './conversation-projections.ts';

export interface AgentConversationSettlement {
	submissionId: string;
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
	/**
	 * The submission whose response answered this one — for a delivery that
	 * joined a live response, the host submission whose reply coalesced it.
	 * Derived at projection time from the attempt shared by the settlement
	 * record and the response's assistant records (nothing stamps it at
	 * settle time). Absent on settlements that predate attempt stamping and
	 * on attempts that produced no assistant message.
	 */
	answeredBySubmissionId?: string;
	/** Capture time (ISO 8601) of the `submission_settled` record. */
	timestamp?: string;
}

/**
 * A materialized conversation read at a durable-stream offset. Wire-compatible
 * with @flue/sdk's `FlueConversationSnapshot`.
 */
export interface AgentConversationSnapshot {
	v: 1;
	conversationId: string;
	offset: string;
	/**
	 * Durable stream-generation identity (see `ConversationStreamMeta.incarnation`).
	 * A reset-and-regrown stream (dev restart on the in-memory store, wiped
	 * store) serves different content at overlapping offsets; the incarnation is
	 * what lets a client detect that its offsets belong to a dead generation.
	 * Stamped by the history route from stream meta — absent on snapshots
	 * projected without meta access (`conversation-reset` chunks), where the
	 * generation cannot have changed within the delivering connection.
	 */
	incarnation?: string;
	messages: ConversationUiMessage[];
	settlements: AgentConversationSettlement[];
	/**
	 * Present only on bounded history reads (`limit` / `from`): the cursor for
	 * the next older page — the id of the oldest returned message — or `null`
	 * when `messages` starts at the beginning of the conversation. Absent on
	 * unbounded reads and on `conversation-reset` snapshots.
	 */
	before?: string | null;
}

/**
 * Incremental UI projection protocol carried by the `updates` view.
 * Wire-compatible with @flue/sdk's internal `ConversationStreamChunk`. The
 * canonical record schema is never exposed; these chunks describe only
 * UI-relevant conversation operations.
 *
 * Boundary chunks (`message-started`, `tool-input`, `tool-output`,
 * `tool-output-error`, `message-completed`, `submission-settled`) carry the
 * capture-time `timestamp` of their underlying canonical record so run
 * chronology can be reconstructed from the stream; `message-appended` carries
 * it on the embedded message (the same value the snapshot projects).
 * `message-delta` deliberately omits it for wire weight — consumers
 * interpolate between stamped boundaries.
 */
export type ConversationStreamChunkBody =
	| { type: 'conversation-reset'; conversationId: string; snapshot: AgentConversationSnapshot }
	| { type: 'message-appended'; conversationId: string; message: ConversationUiMessage }
	| {
			type: 'message-started';
			conversationId: string;
			messageId: string;
			submissionId?: string;
			/** Turn this assistant message belongs to; the SDK stamps it onto the
			 *  synthesized message so live grouping matches the snapshot projection. */
			turnId?: string;
			/** Agent-authored response metadata from `useResponseStart` hooks. */
			metadata?: Record<string, unknown>;
			/** Capture time (ISO 8601) of the underlying canonical record. */
			timestamp?: string;
	  }
	| {
			type: 'message-metadata';
			conversationId: string;
			messageId: string;
			metadata: Record<string, unknown>;
	  }
	| {
			type: 'data-part';
			conversationId: string;
			messageId: string;
			name: string;
			data: unknown;
	  }
	| {
			type: 'message-delta';
			conversationId: string;
			messageId: string;
			kind: 'text' | 'reasoning';
			delta: string;
	  }
	| {
			type: 'tool-input';
			conversationId: string;
			messageId: string;
			toolCallId: string;
			toolName: string;
			input: unknown;
			timestamp?: string;
	  }
	| {
			type: 'tool-output';
			conversationId: string;
			toolCallId: string;
			output: unknown;
			durationMs?: number;
			timestamp?: string;
	  }
	| {
			type: 'tool-output-error';
			conversationId: string;
			toolCallId: string;
			errorText: string;
			durationMs?: number;
			timestamp?: string;
	  }
	| { type: 'message-completed'; conversationId: string; messageId: string; timestamp?: string }
	| {
			type: 'submission-settled';
			conversationId: string;
			submissionId: string;
			outcome: 'completed' | 'failed' | 'aborted';
			error?: unknown;
			/** See {@link AgentConversationSettlement.answeredBySubmissionId}. */
			answeredBySubmissionId?: string;
			timestamp?: string;
	  };

/**
 * Monotonic ordering token stamped on every chunk. `batch` is the durable batch
 * ordinal the chunk was projected from; `index` is the chunk's position within
 * that batch's projection. Consumers compare it (lexicographically by `batch`
 * then `index`) to dedupe chunks redelivered under at-least-once transports
 * (e.g. an SSE reconnect). Opaque otherwise — do not interpret the numbers.
 */
type ConversationChunkPosition = { batch: number; index: number };

export type ConversationStreamChunk = ConversationStreamChunkBody & {
	position: ConversationChunkPosition;
};

/**
 * Wire-only continuity marker for the `updates` view. Carries the stream's
 * durable generation identity so a client can detect that its resume offsets
 * belong to a dead generation (a reset-and-regrown stream serves different
 * content at overlapping offsets — and replayed positions would be silently
 * eaten by position dedup). Minted by the HTTP read handlers — once per SSE
 * connection (the first data frame, so DS-internal reconnects get a fresh one)
 * and on every JSON updates response — never by the projection, so in-process
 * observers (`observeSubmissionSettlement`) never see it. It carries no
 * `position` (it is not conversation content and must not disturb dedup) and
 * no `conversationId` (it describes the stream, which exists before any
 * conversation does).
 */
export interface ConversationStreamCheckpointChunk {
	type: 'stream-checkpoint';
	incarnation: string;
}

/** Everything the `updates` wire can carry: projected chunks plus wire-only markers. */
export type ConversationStreamWireChunk =
	| ConversationStreamChunk
	| ConversationStreamCheckpointChunk;
