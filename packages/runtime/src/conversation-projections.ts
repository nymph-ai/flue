/**
 * The UI message shape of the public conversation wire, structurally
 * identical to `@flue/sdk`'s `FlueConversationMessage`. The runtime cannot
 * import the SDK, so the shape is mirrored here and asserted by the snapshot
 * wire contract.
 */

/**
 * Materialized conversation part. Structurally identical to @flue/sdk's
 * `FlueConversationPart` — the public projection shape. The runtime cannot
 * import the SDK, so the shape is mirrored here and asserted by the snapshot
 * wire contract.
 */
export type ConversationUiPart =
	| { type: 'text'; text: string; state: 'streaming' | 'done' }
	| { type: 'reasoning'; text: string; state: 'streaming' | 'done' }
	// A named client-facing data part (`useDataWriter`), AI SDK convention:
	// the part type is `data-<name>` and the payload rides `data`.
	| { type: `data-${string}`; data: unknown }
	// `url` mirrors the SDK shape but is never set server-side (the runtime does
	// not know the HTTP mount/baseUrl); the SDK fills it in for consumers.
	| { type: 'file'; mediaType: string; id?: string; size?: number; url?: string; filename?: string }
	| ({ type: 'dynamic-tool'; toolName: string; toolCallId: string } & (
			| { state: 'input-available'; input: unknown }
			// `durationMs` is the tool-handler execution time; present once the
			// outcome is known (absent on outcomes recorded before the field).
			| { state: 'output-available'; input: unknown; output: unknown; durationMs?: number }
			| { state: 'output-error'; input: unknown; errorText: string; durationMs?: number }
	  ));

/**
 * Coarse render lane for a materialized message. `system` covers every
 * non-chat, non-answer message (internal control input and runtime advisories),
 * mirroring the standard chat convention so a generic renderer can lay a
 * transcript out without understanding Flue's finer {@link ConversationMessagePurpose}.
 */
type ConversationMessageRole = 'user' | 'assistant' | 'system';

/**
 * Stable semantic classification of a message, independent of its rendered
 * text. Lets clients distinguish public chat, assistant answers, internal
 * dispatch/control input, and runtime advisories without parsing content,
 * ordering, or timestamps.
 *
 * The union is intentionally open to future widening (`activity`, `notification`,
 * `state`) as the runtime grows typed agent-activity and attached-agent signals;
 * only the currently-emitted values are listed here.
 */
export type ConversationMessagePurpose = 'user' | 'assistant' | 'dispatch' | 'advisory';

/**
 * How a transcript UI should treat a message: `visible` for primary chat,
 * `diagnostic` for content a client may surface in an activity/diagnostics
 * panel, `hidden` for runtime plumbing that should not normally be shown.
 */
export type ConversationMessageDisplay = 'visible' | 'hidden' | 'diagnostic';

/**
 * Typed detail for a message projected from an internal signal record. Present
 * only on `system`-role messages. `tagName` is the signal's stable label and
 * `attributes` its structured metadata; both carry across history snapshots and
 * live updates so clients can subtype or correlate signals without parsing text.
 */
interface ConversationSignalDescriptor {
	tagName?: string;
	attributes?: Record<string, string>;
}

/**
 * Structured settlement marker on a terminal advisory message. Present only on
 * the advisory the runtime appends when a submission settles short of a reply,
 * reusing the public settlement-outcome vocabulary so clients can react to a
 * failed or aborted turn structurally instead of parsing advisory prose.
 * Completed submissions get no timeline marker — the assistant reply is the
 * marker — and `settlements[]` on snapshots remains the programmatic index.
 */
interface ConversationSettlementMarker {
	outcome: 'failed' | 'aborted';
}

export interface ConversationUiMessage {
	/**
	 * Stable message identity. An assistant message represents one whole
	 * response: every model step of a tracked submission folds into the
	 * submission's first assistant message (parts accumulate across steps in
	 * record order), so `id` is the first step's message id.
	 */
	id: string;
	role: ConversationMessageRole;
	/** Stable semantic classification; see {@link ConversationMessagePurpose}. */
	purpose: ConversationMessagePurpose;
	/** Render/visibility hint; see {@link ConversationMessageDisplay}. */
	display: ConversationMessageDisplay;
	/** Present on messages produced by a tracked submission. */
	submissionId?: string;
	/**
	 * Stable per-turn grouping identity. Shared by every message recorded within
	 * one model round-trip; absent on messages recorded outside a turn.
	 */
	turnId?: string;
	/** Typed signal detail; present only on `system`-role messages. */
	signal?: ConversationSignalDescriptor;
	/**
	 * Structured settlement marker; present only on the terminal advisory the
	 * runtime writes for a failed or aborted submission. See
	 * {@link ConversationSettlementMarker}.
	 */
	settlement?: ConversationSettlementMarker;
	/**
	 * Server-authored capture time (ISO 8601) of the message's underlying
	 * canonical record: the user/signal record for `user`/`system` messages,
	 * the first step's `assistant_message_started` for an assistant response.
	 * A user message's time is when its input was applied to the conversation,
	 * not when the submission was accepted. Server wall-clock: not guaranteed
	 * unique or monotonic, so order by array position, never by timestamp.
	 */
	timestamp?: string;
	parts: ConversationUiPart[];
	/**
	 * Message metadata is entirely agent-authored (`useResponseStart`/`useResponseFinish`
	 * producers, deep-merged in call order). The runtime stamps nothing into
	 * it — keys like `usage` or `model` are app conventions, present only when
	 * the agent attaches them. Server capture time lives on `timestamp`.
	 */
	metadata?: Record<string, unknown>;
}
