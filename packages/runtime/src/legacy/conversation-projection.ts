/**
 * The pre-upgrade conversation wire projection, over the legacy record
 * reducer (PI_UPGRADE_PLAN.md §7 step 8). Kept for one release so a stream
 * written before the Pi cutover still reads (`legacy/conversation-source.ts`)
 * and can be imported (`legacy/import.ts`); delete it with them.
 */
import type {
	AgentConversationSettlement,
	AgentConversationSnapshot,
	ConversationStreamChunk,
	ConversationStreamChunkBody,
} from '../conversation-public.ts';
import type {
	ConversationMessageDisplay,
	ConversationMessagePurpose,
	ConversationUiMessage,
	ConversationUiPart,
} from '../conversation-projections.ts';
import { toolResultOutput, toolResultText } from '../message-rendering.ts';
import type {
	AttachmentRef,
	ConversationRecord,
	SubmissionSettledRecord,
} from './conversation-records.ts';
import {
	getActiveConversationPath,
	hasUncommittedToolBatchAtLeaf,
	type InProgressAssistantMessage,
	type ReducedConversationState,
	type ReducedInstanceState,
	type ReducedMessageEntry,
	toolResultEntryId,
} from './conversation-reducer.ts';

type ConversationSignalDescriptor = NonNullable<ConversationUiMessage['signal']>;
type ConversationSettlementMarker = NonNullable<ConversationUiMessage['settlement']>;

/**
 * Map an internal signal type to its stable public classification. Keeps the
 * canonical signal vocabulary off the wire: only the derived `purpose`/`display`
 * cross the contract, so internal signal types can evolve without changing it.
 *
 * The runtime itself only ever writes the handful of internal signal types
 * enumerated below (recovery advisories and terminal-outcome markers) — every
 * other signal type is caller-defined, written only by a `dispatch()` call
 * delivering a `kind: 'signal'` message (see the phase 2 unified-delivery
 * plan). That's why `default` classifies as `purpose: 'dispatch'` rather than
 * `'advisory'`: by construction, anything reaching `default` arrived through
 * dispatch, not from the runtime's own internal bookkeeping.
 */
function classifySignal(signalType: string): {
	purpose: ConversationMessagePurpose;
	display: ConversationMessageDisplay;
	settlement?: ConversationSettlementMarker;
} {
	switch (signalType) {
		case 'stream_interrupted':
		case 'stream_continued':
			return { purpose: 'advisory', display: 'hidden' };
		// Terminal-outcome markers, written by `recordSubmissionTerminal`:
		// `submission_aborted` is the distinct aborted outcome;
		// `submission_interrupted` covers every failure terminal path (retry
		// exhaustion, timeout, pre-input interruption). The structured
		// `settlement` marker mirrors that split so clients never parse the
		// advisory prose.
		case 'submission_aborted':
			return { purpose: 'advisory', display: 'diagnostic', settlement: { outcome: 'aborted' } };
		case 'submission_interrupted':
			return { purpose: 'advisory', display: 'diagnostic', settlement: { outcome: 'failed' } };
		// Dynamic-resource narration: runtime bookkeeping announcing that the
		// declared tools/skills/subagents changed, not a caller dispatch.
		case 'resources':
		// Instruction-change narration: the composed instruction document
		// moved between renders; announcement only, same bookkeeping family.
		case 'instructions':
		// Environment-swap narration: a conditional sandbox attached, detached,
		// or was replaced at a turn boundary; full-snapshot announcement, same
		// bookkeeping family.
		case 'environment':
			return { purpose: 'advisory', display: 'diagnostic' };
		default:
			return { purpose: 'dispatch', display: 'diagnostic' };
	}
}

function fileFromAttachment(attachment: AttachmentRef): ConversationUiPart {
	return {
		type: 'file',
		mediaType: attachment.mimeType,
		id: attachment.id,
		size: attachment.size,
		...(attachment.filename ? { filename: attachment.filename } : {}),
	};
}

export interface ConversationUiSnapshot {
	conversationId: string;
	streamOffset: string;
	messages: ConversationUiMessage[];
}

/**
 * Completed model errors stay visible until the same submission starts a
 * replacement step. Once replaced, keep the first step's response shell (its
 * id is the stable live-stream target) but omit the superseded model content.
 */
function supersededAssistantErrorEntryIds(
	conversation: ReducedConversationState,
): ReadonlySet<string> {
	const path = getActiveConversationPath(conversation);
	const laterSubmissions = new Set(
		[...conversation.inProgressMessages.values()].flatMap((message) =>
			message.submissionId ? [message.submissionId] : [],
		),
	);
	const superseded = new Set<string>();
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (entry?.type !== 'message' || entry.message.role !== 'assistant') continue;
		if (
			entry.message.stopReason === 'error' &&
			entry.submissionId &&
			laterSubmissions.has(entry.submissionId)
		) {
			superseded.add(entry.id);
		}
		if (entry.submissionId) laterSubmissions.add(entry.submissionId);
	}
	return superseded;
}

function projectConversationUi(
	conversation: ReducedConversationState,
	streamOffset: string,
): ConversationUiSnapshot {
	const messages: ConversationUiMessage[] = [];
	const byId = new Map<string, ConversationUiMessage>();
	const supersededErrors = supersededAssistantErrorEntryIds(conversation);
	// One UI message per assistant response (the UIMessage ecosystem shape):
	// every assistant step of a tracked submission folds into the submission's
	// first assistant message, parts accumulating across steps in record order.
	const responseBySubmission = new Map<string, ConversationUiMessage>();
	for (const entry of getActiveConversationPath(conversation)) {
		if (entry.type !== 'message') continue;
		const projected = projectCompletedMessage(entry, supersededErrors.has(entry.id));
		if (projected) {
			if (projected.role === 'assistant' && projected.submissionId) {
				const open = responseBySubmission.get(projected.submissionId);
				if (open) {
					mergeAssistantContinuation(open, projected);
					appendAnchoredDataParts(open, conversation, projected.submissionId, projected.id);
					continue;
				}
				responseBySubmission.set(projected.submissionId, projected);
				appendAnchoredDataParts(projected, conversation, projected.submissionId, projected.id);
				applyResponseMetadata(projected, conversation);
			}
			messages.push(projected);
			byId.set(projected.id, projected);
			continue;
		}
		if (entry.message.role !== 'toolResult') continue;
		const toolResult = entry.message;
		for (let index = messages.length - 1; index >= 0; index--) {
			const candidate = messages[index];
			// toolCallIds are only unique per assistant step (the reducer keys
			// outcomes by assistant message), and steps of one submission merge
			// into one response message — so backfill the latest matching call
			// still awaiting output, never a part that already resolved.
			const partIndex =
				candidate?.parts.findLastIndex(
					(value) =>
						value.type === 'dynamic-tool' &&
						value.toolCallId === toolResult.toolCallId &&
						value.state === 'input-available',
				) ?? -1;
			if (!candidate || partIndex < 0) continue;
			const part = candidate.parts[partIndex] as Extract<
				ConversationUiPart,
				{ type: 'dynamic-tool' }
			>;
			candidate.parts[partIndex] = toolResult.isError
				? {
						type: 'dynamic-tool',
						toolName: part.toolName,
						toolCallId: part.toolCallId,
						state: 'output-error',
						input: part.input,
						errorText: toolResultText(toolResult.content),
						...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
					}
				: {
						type: 'dynamic-tool',
						toolName: part.toolName,
						toolCallId: part.toolCallId,
						state: 'output-available',
						input: part.input,
						output: entry.toolOutput
							? entry.toolOutput.value
							: toolResultOutput(toolResult.content),
						...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
					};
			break;
		}
	}
	for (const inProgress of conversation.inProgressMessages.values()) {
		const projected = projectInProgressMessage(inProgress);
		if (!projected || byId.has(projected.id)) continue;
		// A live continuation stream (parented on the current leaf) extends its
		// submission's open response message. Anything else — e.g. a ghost
		// partial from an interrupted attempt awaiting terminalization —
		// projects standalone, as before.
		const open =
			projected.submissionId && inProgress.parentId === conversation.activeLeafId
				? responseBySubmission.get(projected.submissionId)
				: undefined;
		if (open) {
			mergeAssistantContinuation(open, projected);
			continue;
		}
		if (projected.submissionId) applyResponseMetadata(projected, conversation);
		messages.push(projected);
	}
	return { conversationId: conversation.conversationId, streamOffset, messages };
}

/**
 * Fold a later assistant step of the same submission into its response
 * message: parts append in record order; identity fields (id, turnId) stay
 * the first step's.
 */
function mergeAssistantContinuation(
	open: ConversationUiMessage,
	continuation: ConversationUiMessage,
): void {
	open.parts.push(...continuation.parts);
}

/**
 * Append the response's data parts anchored to one assistant step, right
 * after that step's own parts — the position a live client saw them stream
 * into. First-write order within a step; a rewrite updated `data` in place.
 */
function appendAnchoredDataParts(
	message: ConversationUiMessage,
	conversation: ReducedConversationState,
	submissionId: string,
	anchorEntryId: string,
): void {
	const parts = conversation.responseDataParts.get(submissionId);
	if (!parts) return;
	for (const part of parts) {
		if (part.anchorEntryId !== anchorEntryId) continue;
		message.parts.push({ type: `data-${part.name}`, data: part.data });
	}
}

/** Attach the response's agent-authored metadata (`useResponseStart`/`useResponseFinish`). */
function applyResponseMetadata(
	message: ConversationUiMessage,
	conversation: ReducedConversationState,
): void {
	if (!message.submissionId) return;
	const custom = conversation.responseMetadata.get(message.submissionId);
	if (custom) message.metadata = custom;
}

function projectCompletedMessage(
	entry: ReducedMessageEntry,
	omitAssistantContent = false,
): ConversationUiMessage | undefined {
	const message = entry.message;
	if (message.role === 'user') {
		const parts: ConversationUiPart[] = [];
		if (typeof message.content === 'string') {
			parts.push({ type: 'text', text: message.content, state: 'done' });
		} else {
			for (const block of message.content) {
				if (block.type === 'text') parts.push({ type: 'text', text: block.text, state: 'done' });
				else {
					const attachment = entry.attachmentRefs?.get(block.data);
					if (attachment) parts.push(fileFromAttachment(attachment));
				}
			}
		}
		return {
			id: entry.id,
			role: 'user',
			purpose: 'user',
			display: 'visible',
			...(entry.submissionId ? { submissionId: entry.submissionId } : {}),
			...(entry.turnId ? { turnId: entry.turnId } : {}),
			...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
			parts,
		};
	}
	if (message.role === 'signal') {
		const { purpose, display, settlement } = classifySignal(message.type);
		const signal: ConversationSignalDescriptor = {
			...(message.tagName ? { tagName: message.tagName } : {}),
			...(message.attributes ? { attributes: message.attributes } : {}),
		};
		return {
			id: entry.id,
			role: 'system',
			purpose,
			display,
			...(entry.submissionId ? { submissionId: entry.submissionId } : {}),
			...(entry.turnId ? { turnId: entry.turnId } : {}),
			...(Object.keys(signal).length > 0 ? { signal } : {}),
			...(settlement ? { settlement } : {}),
			...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
			parts: [{ type: 'text', text: message.content, state: 'done' }],
		};
	}
	if (message.role !== 'assistant') return undefined;
	return {
		id: entry.id,
		role: 'assistant',
		purpose: 'assistant',
		display: 'visible',
		submissionId: entry.submissionId,
		...(entry.turnId ? { turnId: entry.turnId } : {}),
		...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
		parts: omitAssistantContent
			? []
			: message.content.map((block): ConversationUiPart => {
					if (block.type === 'text') {
						return { type: 'text', text: block.text, state: 'done' };
					}
					if (block.type === 'thinking') {
						return { type: 'reasoning', text: block.thinking, state: 'done' };
					}
					return {
						type: 'dynamic-tool',
						toolCallId: block.id,
						toolName: block.name,
						input: block.arguments,
						state: 'input-available',
					};
				}),
	};
}

function projectInProgressMessage(
	message: InProgressAssistantMessage,
): ConversationUiMessage | undefined {
	const parts = [...message.blocks.values()]
		.sort((a, b) => a.blockIndex - b.blockIndex)
		.map((block): ConversationUiPart => {
			if (block.type === 'text') {
				return {
					type: 'text',
					text: block.deltas.join(''),
					state: block.completed ? 'done' : 'streaming',
				};
			}
			if (block.type === 'reasoning') {
				return {
					type: 'reasoning',
					text: block.deltas.join(''),
					state: block.completed ? 'done' : 'streaming',
				};
			}
			return {
				type: 'dynamic-tool',
				toolCallId: block.toolCallId,
				toolName: block.name,
				input: block.arguments,
				state: 'input-available',
			};
		});
	// Always project the in-progress shell, even with zero parts: a client that
	// hydrates a snapshot taken between `assistant_message_started` and its first
	// delta needs the message to exist so later streamed deltas attach instead of
	// being dropped (the message-started record precedes the resume offset).
	return {
		id: message.messageId,
		role: 'assistant',
		purpose: 'assistant',
		display: 'visible',
		// Carry submissionId/turnId so a mid-stream snapshot (e.g. a reset forced
		// by compaction) reprojects the same grouping identity the live
		// `message-started` chunk and the completed projection already emit.
		...(message.submissionId ? { submissionId: message.submissionId } : {}),
		...(message.turnId ? { turnId: message.turnId } : {}),
		...(message.timestamp ? { timestamp: message.timestamp } : {}),
		parts,
	};
}

// The public conversation API addresses exactly one conversation per agent
// instance: the default harness/session root. An instance can hold other root
// conversations too (internal named sessions each open one), so the default
// must be selected by its stable identity rather than by record order. Fall
// back to any root only when no default scope exists, preserving the prior
// behavior for instances that never used the default session.
const DEFAULT_HARNESS = 'default';
const DEFAULT_SESSION = 'default';

function selectRootConversation(state: ReducedInstanceState) {
	const roots = [...state.conversations.values()].filter(
		(conversation) => conversation.kind === 'root',
	);
	return (
		roots.find(
			(conversation) =>
				conversation.harness === DEFAULT_HARNESS && conversation.session === DEFAULT_SESSION,
		) ?? roots[0]
	);
}

export function projectAgentConversationSnapshot(
	state: ReducedInstanceState,
): AgentConversationSnapshot | undefined {
	const conversation = selectRootConversation(state);
	if (!conversation) return undefined;
	const ui: ConversationUiSnapshot = projectConversationUi(
		conversation,
		state.recordsThroughOffset,
	);
	return {
		v: 1,
		conversationId: conversation.conversationId,
		offset: ui.streamOffset,
		messages: ui.messages,
		settlements: projectSettlements(state, conversation.conversationId),
	};
}

/**
 * Ids of the projected messages in the root conversation that can still be
 * the target of a future live chunk. A bounded history window must include
 * all of them (see `conversation-history-window.ts`): the live stream
 * addresses streaming content, metadata, data parts, tool results, and
 * completion to a message by id, and a client drops chunks for messages it
 * does not hold — so cutting one out loses its future content for good.
 *
 * - The response message of every tracked submission that has not settled.
 *   A response keeps its first step's position while later steps (possibly
 *   after joined deliveries) stream into it, so it can sit well above the
 *   newest messages.
 * - Every in-progress assistant message, under both its response id and its
 *   own id (an interrupted ghost projects standalone until terminalized),
 *   including zero-part shells.
 * - The leaf assistant of an uncommitted tool batch, whose tool results are
 *   still to arrive (covers untracked turns with no submission).
 */
export function projectLiveMessageTargets(state: ReducedInstanceState): ReadonlySet<string> {
	const targets = new Set<string>();
	const conversation = selectRootConversation(state);
	if (!conversation) return targets;
	const settled = new Set(
		projectSettlements(state, conversation.conversationId).map((entry) => entry.submissionId),
	);
	const responseIds = buildResponseMessageIndex(conversation);
	for (const [submissionId, messageId] of responseIds) {
		if (!settled.has(submissionId)) targets.add(messageId);
	}
	for (const message of conversation.inProgressMessages.values()) {
		targets.add(message.messageId);
		const response = message.submissionId ? responseIds.get(message.submissionId) : undefined;
		if (response) targets.add(response);
	}
	if (hasUncommittedToolBatchAtLeaf(conversation) && conversation.activeLeafId) {
		const leaf = conversation.entries.get(conversation.activeLeafId);
		const response =
			leaf?.type === 'message' && leaf.submissionId
				? responseIds.get(leaf.submissionId)
				: undefined;
		targets.add(response ?? conversation.activeLeafId);
	}
	return targets;
}

export function projectAgentConversationBatch(options: {
	state: ReducedInstanceState;
	previousState?: ReducedInstanceState;
	records: readonly ConversationRecord[];
	/** Durable batch ordinal these records were read at; stamped onto each chunk. */
	batchOrdinal: number;
}): ConversationStreamChunk[] {
	const conversation =
		selectRootConversation(options.state) ??
		(options.previousState ? selectRootConversation(options.previousState) : undefined);
	if (!conversation) return [];
	const conversationId = conversation.conversationId;
	const relevant = options.records.filter((record) => record.conversationId === conversationId);
	if (relevant.length === 0) return [];

	// A reset subsumes the whole batch: a fresh snapshot already reflects every
	// record in it, so emitting per-record chunks too would double-apply.
	if (relevant.some((record) => requiresSnapshotReset(record, options.state))) {
		const snapshot = projectAgentConversationSnapshot(options.state);
		return snapshot
			? withPositions(
					[{ type: 'conversation-reset', conversationId, snapshot }],
					options.batchOrdinal,
				)
			: [];
	}

	const responseIds = buildResponseMessageIndex(conversation);
	return withPositions(
		relevant.flatMap((record) => encodeRecord(record, conversationId, options.state, responseIds)),
		options.batchOrdinal,
	);
}

/**
 * Map each tracked submission to its response message id — the first
 * assistant messageId recorded for the submission. Chunk encoding rewrites
 * every assistant-scoped record onto this id so the live stream assembles the
 * same one-message-per-response shape the snapshot projection produces (a
 * later step's `message-started` then dedupes client-side and its parts
 * accumulate on the open message).
 */
function buildResponseMessageIndex(conversation: ReducedConversationState): Map<string, string> {
	const first = new Map<string, string>();
	for (const entry of getActiveConversationPath(conversation)) {
		if (entry.type !== 'message' || entry.message.role !== 'assistant' || !entry.submissionId) {
			continue;
		}
		if (!first.has(entry.submissionId)) first.set(entry.submissionId, entry.id);
	}
	for (const message of conversation.inProgressMessages.values()) {
		if (!message.submissionId || first.has(message.submissionId)) continue;
		first.set(message.submissionId, message.messageId);
	}
	return first;
}

/**
 * Stamp each chunk with its position within the batch. Index is the chunk's
 * order in the batch's projection (a single record may fan out to several
 * chunks), so `{ batch, index }` is globally unique and monotonic across the
 * conversation. This is the identity consumers dedupe on under redelivery.
 */
function withPositions(
	bodies: ConversationStreamChunkBody[],
	batch: number,
): ConversationStreamChunk[] {
	return bodies.map((body, index) => ({ ...body, position: { batch, index } }));
}

function requiresSnapshotReset(record: ConversationRecord, state: ReducedInstanceState): boolean {
	if (record.type === 'conversation_created' || record.type === 'compaction') return true;
	if (record.type !== 'assistant_message_started' || !record.submissionId) return false;
	// A live client already rendered the failed step's partial parts onto the
	// response id. Starting its replacement must retract those parts before new
	// deltas target that same stable id; the snapshot projection supplies the
	// corrected response shell.
	const conversation = state.conversations.get(record.conversationId);
	if (!conversation) return false;
	const superseded = supersededAssistantErrorEntryIds(conversation);
	return getActiveConversationPath(conversation).some(
		(entry) =>
			entry.type === 'message' &&
			entry.message.role === 'assistant' &&
			entry.submissionId === record.submissionId &&
			superseded.has(entry.id),
	);
}

function encodeRecord(
	record: ConversationRecord,
	conversationId: string,
	state: ReducedInstanceState,
	responseIds: Map<string, string>,
): ConversationStreamChunkBody[] {
	// Assistant records of a tracked submission address the submission's
	// response message, not the per-step canonical message.
	const uiMessageId = (messageId: string): string =>
		(record.submissionId ? responseIds.get(record.submissionId) : undefined) ?? messageId;
	switch (record.type) {
		case 'user_message':
			return [
				{
					type: 'message-appended',
					conversationId,
					message: {
						id: record.messageId,
						role: 'user',
						purpose: 'user',
						display: 'visible',
						...(record.submissionId ? { submissionId: record.submissionId } : {}),
						...(record.turnId ? { turnId: record.turnId } : {}),
						...(record.timestamp ? { timestamp: record.timestamp } : {}),
						parts: record.content.map((content) =>
							content.type === 'text'
								? { type: 'text', text: content.text, state: 'done' }
								: {
										type: 'file',
										mediaType: content.attachment.mimeType,
										id: content.attachment.id,
										size: content.attachment.size,
										...(content.attachment.filename
											? { filename: content.attachment.filename }
											: {}),
									},
						),
					},
				},
			];
		case 'signal': {
			const { purpose, display, settlement } = classifySignal(record.signalType);
			const signal = {
				...(record.tagName ? { tagName: record.tagName } : {}),
				...(record.attributes ? { attributes: record.attributes } : {}),
			};
			return [
				{
					type: 'message-appended',
					conversationId,
					message: {
						id: record.messageId,
						role: 'system',
						purpose,
						display,
						...(record.submissionId ? { submissionId: record.submissionId } : {}),
						...(record.turnId ? { turnId: record.turnId } : {}),
						...(Object.keys(signal).length > 0 ? { signal } : {}),
						...(settlement ? { settlement } : {}),
						...(record.timestamp ? { timestamp: record.timestamp } : {}),
						parts: [{ type: 'text', text: record.content, state: 'done' }],
					},
				},
			];
		}
		case 'assistant_message_started':
			return [
				{
					type: 'message-started',
					conversationId,
					messageId: uiMessageId(record.messageId),
					...(record.submissionId ? { submissionId: record.submissionId } : {}),
					...(record.turnId ? { turnId: record.turnId } : {}),
					...(record.responseMetadata ? { metadata: record.responseMetadata } : {}),
					...(record.timestamp ? { timestamp: record.timestamp } : {}),
				},
			];
		case 'message_metadata': {
			const messageId = record.submissionId ? responseIds.get(record.submissionId) : undefined;
			return messageId
				? [{ type: 'message-metadata', conversationId, messageId, metadata: record.metadata }]
				: [];
		}
		case 'message_data_write': {
			const messageId = record.submissionId ? responseIds.get(record.submissionId) : undefined;
			return messageId
				? [{ type: 'data-part', conversationId, messageId, name: record.name, data: record.data }]
				: [];
		}
		case 'assistant_text_delta':
			return [
				{
					type: 'message-delta',
					conversationId,
					messageId: uiMessageId(record.messageId),
					kind: 'text',
					delta: record.delta,
				},
			];
		case 'assistant_reasoning_delta':
			return [
				{
					type: 'message-delta',
					conversationId,
					messageId: uiMessageId(record.messageId),
					kind: 'reasoning',
					delta: record.delta,
				},
			];
		// Block lifecycle (`assistant_text_started`/`assistant_*_completed`) carries no
		// UI-visible payload: the first delta opens a streaming part, a `kind` change or
		// `message-completed` closes it. So those records project to no chunk.
		case 'assistant_tool_call':
			return [
				{
					type: 'tool-input',
					conversationId,
					messageId: uiMessageId(record.messageId),
					toolCallId: record.toolCallId,
					toolName: record.name,
					input: record.arguments,
					...(record.timestamp ? { timestamp: record.timestamp } : {}),
				},
			];
		case 'assistant_message_completed':
			return [
				{
					type: 'message-completed',
					conversationId,
					messageId: uiMessageId(record.messageId),
					...(record.timestamp ? { timestamp: record.timestamp } : {}),
				},
			];
		case 'tool_results_committed': {
			const conversation = state.conversations.get(record.conversationId);
			if (!conversation) return [];
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (assistant?.type !== 'message' || assistant.message.role !== 'assistant') return [];
			// The fold guarantees one committed tool-result entry per assistant
			// tool call, in call order — the same entries the snapshot projection
			// renders, so the live stream cannot drift from it.
			return assistant.message.content.flatMap((block) =>
				block.type === 'toolCall'
					? encodeToolResultEntry(conversation, record.assistantMessageId, block.id, conversationId)
					: [],
			);
		}
		case 'submission_settled': {
			const answeredBy =
				typeof record.attemptId === 'string'
					? assistantSubmissionByAttempt(state).get(record.attemptId)
					: undefined;
			return [
				{
					type: 'submission-settled',
					conversationId,
					submissionId: record.submissionId,
					outcome: record.outcome,
					...(record.error === undefined ? {} : { error: record.error }),
					...(answeredBy === undefined ? {} : { answeredBySubmissionId: answeredBy }),
					...(record.timestamp ? { timestamp: record.timestamp } : {}),
				},
			];
		}
		default:
			return [];
	}
}

function encodeToolResultEntry(
	conversation: ReducedConversationState,
	assistantMessageId: string,
	toolCallId: string,
	conversationId: string,
): ConversationStreamChunkBody[] {
	const entry = conversation.entries.get(toolResultEntryId(assistantMessageId, toolCallId));
	if (entry?.type !== 'message' || entry.message.role !== 'toolResult') return [];
	const result = entry.message;
	// The entry carries the outcome's own capture time (when the tool result
	// was recorded), not the commit record's batch time.
	return result.isError
		? [
				{
					type: 'tool-output-error',
					conversationId,
					toolCallId: result.toolCallId,
					errorText: toolResultText(result.content),
					...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
					...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
				},
			]
		: [
				{
					type: 'tool-output',
					conversationId,
					toolCallId: result.toolCallId,
					output: entry.toolOutput ? entry.toolOutput.value : toolResultOutput(result.content),
					...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
					...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
				},
			];
}

function projectSettlements(
	state: ReducedInstanceState,
	conversationId: string,
): AgentConversationSettlement[] {
	const answeredBy = assistantSubmissionByAttempt(state);
	return [...state.recordsById.values()]
		.filter(
			(record): record is SubmissionSettledRecord =>
				record.type === 'submission_settled' && record.conversationId === conversationId,
		)
		.map((record) => {
			const by =
				typeof record.attemptId === 'string' ? answeredBy.get(record.attemptId) : undefined;
			return {
				submissionId: record.submissionId,
				outcome: record.outcome,
				...(record.error === undefined ? {} : { error: record.error }),
				...(by === undefined ? {} : { answeredBySubmissionId: by }),
				...(record.timestamp ? { timestamp: record.timestamp } : {}),
			};
		});
}

/**
 * Index attempts to the submission whose response ran them. Every canonical
 * record is envelope-stamped with its attempt, and a joined submission
 * settles under its HOST's attempt — so the settlement→attempt→assistant-
 * record chain resolves which submission's response answered a settlement
 * without any settle path stamping a pointer. Settlements that predate
 * attempt stamping simply miss the index (legacy fallback applies).
 */
function assistantSubmissionByAttempt(state: ReducedInstanceState): Map<string, string> {
	const index = new Map<string, string>();
	for (const record of state.recordsById.values()) {
		if (record.type !== 'assistant_message_started') continue;
		if (typeof record.attemptId !== 'string' || typeof record.submissionId !== 'string') continue;
		index.set(record.attemptId, record.submissionId);
	}
	return index;
}
