/**
 * The public conversation wire as a pure projection of Pi commits
 * (PI_UPGRADE_PLAN.md §4, §7 step 7).
 *
 * `projectPiCommit(state, envelope)` folds one canonical `PiCommitEnvelope`
 * into a projection state and returns the `ConversationStreamChunk`s it
 * produced; `projectPiSnapshot(state)` materializes the
 * `AgentConversationSnapshot`. Both reproduce Flue's existing wire exactly —
 * `@flue/sdk` reads it unchanged — so the Pi internals (numeric ids, task
 * records, Chord delta ops, tool memos) never cross the public contract.
 *
 * Only the root conversation (Flue's default session) is projected, as
 * before. The mapping:
 *
 * | Pi | public |
 * |---|---|
 * | root conversation created; `pi.compaction`; a legacy import | `conversation-reset` |
 * | `pi.user` (a submission's input) | `message-appended` (user, or a dispatch signal) |
 * | `pi.live.generation.message` partials | `message-started` / `message-delta` |
 * | `pi.assistant` | remaining deltas, `tool-input`s, `message-completed` |
 * | `pi.tool-result` (once the round's slots are done) | `tool-output` / `tool-output-error` |
 * | `flue.data` / `flue.metadata` | `data-part` / `message-metadata` |
 * | an input submission settling | `submission-settled` (+ the terminal advisory) |
 *
 * Every assistant step of one Pi run folds into one response message keyed
 * by the run's first input, exactly as the legacy projection folded every
 * step of a submission into its first assistant message. Chunk positions are
 * `{ batch: envelope.seq, index }`.
 *
 * The state is plain JSON: the fold host clones it once per advance and folds
 * a window in place (`projectPiCommitInPlace`).
 */
import type { JsonValue } from '@earendil-works/chord';
import { applyImmutable, type Op } from '@earendil-works/chord/delta';
import type { StorageWrite } from '@earendil-works/pi-durable';
import type { AgentConversationSnapshot, ConversationStreamChunk } from '../conversation-public.ts';
import type { ConversationUiMessage } from '../conversation-projections.ts';
import {
	SubmissionAbortedError,
	SubmissionRetryExhaustedError,
	SubmissionTimeoutError,
} from '../errors.ts';
import { toolResultOutput, toolResultText } from '../message-rendering.ts';
import { serializeSubmissionError } from '../runtime/submission-errors.ts';
import type { PiCommitEnvelope } from './commit-envelope.ts';

/** Pi's reserved root conversation id. */
const ROOT = 1;

const KIND_LIVE = 'pi.live';
const KIND_RECEIPTS = 'flue.receipts';
const KIND_RUNS = 'flue.runs';
const ENTRY_USER = 'pi.user';
const ENTRY_ASSISTANT = 'pi.assistant';
const ENTRY_TOOL_RESULT = 'pi.tool-result';
const ENTRY_COMPACTION = 'pi.compaction';
const ENTRY_DATA = 'flue.data';
const ENTRY_METADATA = 'flue.metadata';
/** Written by `legacy/import.ts`: the whole pre-upgrade conversation, as one commit. */
export const ENTRY_IMPORT = 'flue.import';

type UiPart = ConversationUiMessage['parts'][number];
type Settlement = AgentConversationSnapshot['settlements'][number];
type ChunkBody = ConversationStreamChunk extends infer C
	? C extends ConversationStreamChunk
		? Omit<C, 'position'>
		: never
	: never;

/** A Pi `DeliveredMessage` as receipts keep it for display (attachment bytes replaced by refs). */
export type DisplayMessage =
	| {
			kind: 'user';
			body: string;
			attachments?: { id: string; mimeType: string; size: number; filename?: string }[];
	  }
	| {
			kind: 'signal';
			type: string;
			body: string;
			attributes?: { [key: string]: string };
			tagName?: string;
	  };

interface DocSlot {
	kind: string;
	key?: string;
	/** Root-conversation scope, session scope, or anything else. */
	scope: 'root' | 'session' | 'other';
	value: JsonValue | null;
}

interface SubmissionSlot {
	type: 'input' | 'write';
	conversationId: number;
	requestId?: string;
	status: string;
	entry?: number;
	answer?: number;
	reason?: string;
	detail?: JsonValue;
}

interface StepState {
	/** `{generation task id}:{attempt}` of the step streaming now. */
	key: string;
	turnId: string;
	/** Characters already emitted per content index (text/thinking). */
	emitted: { [index: string]: number };
	/** Index into the response message's parts where this step's parts begin. */
	partStart: number;
}

interface ResponseState {
	messageId: string;
	/** Flue submission id of the run's first input. */
	submissionId?: string;
	/** Agent-authored start metadata, as `message-started` carried it. */
	startMetadata?: JsonValue;
	/** Turn id of the latest step (stamped on joined inputs). */
	turnId?: string;
	/** Index of the response message in `messages`. */
	index: number;
	/** Whether a `message-started` already carried the start metadata. */
	metadataSent?: boolean;
}

interface ToolCallState {
	callId: string;
	name: string;
	startedAt?: number;
	result?: { isError: boolean; output: JsonValue; errorText: string; at: number };
}

export interface PiProjectionState {
	readonly v: 1;
	/** Storage incarnation (every envelope of one log carries it). */
	storage?: string;
	/** Seq of the last folded envelope. */
	seq: number;
	rootCreated: boolean;
	docs: { [documentId: string]: DocSlot };
	/** `{scope}|{kind}|{key}` → document id, for the scopes the projection reads. */
	addresses: { [address: string]: string };
	submissions: { [submissionId: string]: SubmissionSlot };
	messages: ConversationUiMessage[];
	settlements: Settlement[];
	/** Response per run key (the run's first Pi input submission id). */
	responses: { [runKey: string]: ResponseState };
	/** Run key per Pi input submission placed into a run. */
	runOf: { [submissionId: string]: string };
	step?: StepState & { runKey: string };
	/** The tool round in flight, in call order; flushed when every slot is done. */
	round?: { runKey: string; calls: ToolCallState[] };
	/** Settled Flue submissions, to settle once. */
	settled: { [submissionId: string]: true };
	/** Response message id → data part index by name. */
	dataParts: { [messageId: string]: { [name: string]: number } };
}

export function initialProjectionState(): PiProjectionState {
	return {
		v: 1,
		seq: 0,
		rootCreated: false,
		docs: {},
		addresses: {},
		submissions: {},
		messages: [],
		settlements: [],
		responses: {},
		runOf: {},
		settled: {},
		dataParts: {},
	};
}

/** Detached copy of a projection state. */
export function cloneProjectionState(state: PiProjectionState): PiProjectionState {
	return structuredClone(state);
}

// ─── Reading the folded state ────────────────────────────────────────────────

function conversationIdOf(state: PiProjectionState): string {
	return `conv_${state.storage ?? 'pending'}`;
}

function addressOf(scope: DocSlot['scope'], kind: string, key: string | undefined): string {
	return `${scope}|${kind}|${key ?? ''}`;
}

function rootDoc(state: PiProjectionState, kind: string): JsonValue | null | undefined {
	const id = state.addresses[addressOf('root', kind, undefined)];
	return id === undefined ? undefined : state.docs[id]?.value;
}

function sessionDoc(
	state: PiProjectionState,
	kind: string,
	key: string,
): JsonValue | null | undefined {
	const id = state.addresses[addressOf('session', kind, key)];
	return id === undefined ? undefined : state.docs[id]?.value;
}

function placeDoc(state: PiProjectionState, id: string, slot: DocSlot): void {
	if (slot.scope === 'other') return;
	state.docs[id] = slot;
	state.addresses[addressOf(slot.scope, slot.kind, slot.key)] = id;
}

type LiveValue = {
	run?: { taskId: number; inputs: number[] };
	generation?: { attempt: number; message?: { content?: JsonValue[] } };
	tools?: { callId: string; name: string; status: string; entry?: number }[];
};

function liveOf(state: PiProjectionState): LiveValue {
	return (rootDoc(state, KIND_LIVE) ?? {}) as LiveValue;
}

type ReceiptValue = {
	status?: string;
	kind?: 'dispatch' | 'direct';
	message?: DisplayMessage;
	classification?: 'exceeded_timeout' | 'exhausted_retry_budget';
	attempts?: number;
	maxAttempts?: number;
};

function receiptOf(
	state: PiProjectionState,
	submissionId: string | undefined,
): ReceiptValue | undefined {
	if (submissionId === undefined) return undefined;
	const value = sessionDoc(state, KIND_RECEIPTS, submissionId);
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as ReceiptValue)
		: undefined;
}

function startMetadataOf(state: PiProjectionState, runKey: string): JsonValue | undefined {
	const runs = rootDoc(state, KIND_RUNS) as
		| { runs?: { [key: string]: { metadata?: JsonValue } } }
		| undefined;
	const metadata = runs?.runs?.[runKey]?.metadata;
	if (
		metadata &&
		typeof metadata === 'object' &&
		!Array.isArray(metadata) &&
		Object.keys(metadata).length > 0
	) {
		return metadata;
	}
	return undefined;
}

function iso(at: number): string {
	return new Date(at).toISOString();
}

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(
	target: { [key: string]: JsonValue },
	source: { [key: string]: JsonValue },
): void {
	for (const [key, value] of Object.entries(source)) {
		const existing = target[key];
		if (isRecord(value) && isRecord(existing)) deepMerge(existing, value);
		else target[key] = structuredClone(value);
	}
}

/** The keys of `next` that `base` does not already carry with the same value. */
function metadataDelta(
	next: { [key: string]: JsonValue },
	base: JsonValue | undefined,
): { [key: string]: JsonValue } {
	const delta: { [key: string]: JsonValue } = {};
	const previous = isRecord(base) ? base : {};
	for (const [key, value] of Object.entries(next)) {
		if (JSON.stringify(previous[key]) !== JSON.stringify(value)) delta[key] = value;
	}
	return delta;
}

// ─── Folding ────────────────────────────────────────────────────────────────

function scopeOf(record: { scope?: { kind?: string; conversationId?: number } }): DocSlot['scope'] {
	if (record.scope?.kind === 'session') return 'session';
	if (record.scope?.kind === 'conversation' && record.scope.conversationId === ROOT) return 'root';
	return 'other';
}

function foldDocuments(state: PiProjectionState, writes: readonly StorageWrite[]): void {
	for (const write of writes) {
		switch (write.type) {
			case 'document.create': {
				const record = write.record as { id: number; kind: string; key?: string };
				placeDoc(state, String(record.id), {
					kind: record.kind,
					...(record.key !== undefined ? { key: record.key } : {}),
					scope: scopeOf(write.record as never),
					value: structuredClone(write.content.value) as JsonValue,
				});
				break;
			}
			case 'document.copy': {
				const record = write.record as { id: number; kind: string; key?: string };
				const source = state.docs[String(write.source.id)];
				placeDoc(state, String(record.id), {
					kind: record.kind,
					...(record.key !== undefined ? { key: record.key } : {}),
					scope: scopeOf(write.record as never),
					value: source ? structuredClone(source.value) : null,
				});
				break;
			}
			case 'document.change': {
				const slot = state.docs[String(write.id)];
				if (!slot) break;
				slot.value =
					write.content.kind === 'base'
						? (structuredClone(write.content.value) as JsonValue)
						: (applyImmutable(slot.value ?? {}, write.content.ops as readonly Op[]) as JsonValue);
				break;
			}
			case 'document.retire': {
				const slot = state.docs[String(write.id)];
				if (!slot) break;
				delete state.docs[String(write.id)];
				const address = addressOf(slot.scope, slot.kind, slot.key);
				if (state.addresses[address] === String(write.id)) delete state.addresses[address];
				break;
			}
			default:
				break;
		}
	}
}

// ─── Projection ─────────────────────────────────────────────────────────────

interface Emitter {
	chunks: ChunkBody[];
	reset: boolean;
}

function ensureResponse(
	state: PiProjectionState,
	runKey: string,
	at: number,
): { response: ResponseState; started: boolean } {
	const existing = state.responses[runKey];
	if (existing) return { response: existing, started: false };
	const firstInput = state.submissions[runKey];
	const submissionId = firstInput?.requestId;
	const startMetadata = startMetadataOf(state, runKey);
	const message: ConversationUiMessage = {
		id: `msg_r${runKey}`,
		role: 'assistant',
		purpose: 'assistant',
		display: 'visible',
		...(submissionId !== undefined ? { submissionId } : {}),
		timestamp: iso(at),
		parts: [],
		...(isRecord(startMetadata) ? { metadata: structuredClone(startMetadata) } : {}),
	};
	state.messages.push(message);
	const response: ResponseState = {
		messageId: message.id,
		...(submissionId !== undefined ? { submissionId } : {}),
		...(startMetadata !== undefined ? { startMetadata } : {}),
		index: state.messages.length - 1,
	};
	state.responses[runKey] = response;
	return { response, started: true };
}

/** The run key of the run in flight: its first input submission id. */
function currentRunKey(live: LiveValue): string | undefined {
	const first = live.run?.inputs[0];
	return first === undefined ? undefined : String(first);
}

/** Map one Pi assistant content block to its UI part. */
function partOf(block: JsonValue, streaming: boolean): UiPart | undefined {
	if (!isRecord(block)) return undefined;
	if (block.type === 'text') {
		return {
			type: 'text',
			text: String(block.text ?? ''),
			state: streaming ? 'streaming' : 'done',
		};
	}
	if (block.type === 'thinking') {
		return {
			type: 'reasoning',
			text: String(block.thinking ?? ''),
			state: streaming ? 'streaming' : 'done',
		};
	}
	if (block.type === 'toolCall') {
		if (streaming) return undefined;
		return {
			type: 'dynamic-tool',
			toolName: String(block.name ?? ''),
			toolCallId: String(block.id ?? ''),
			state: 'input-available',
			input: (block.arguments ?? {}) as JsonValue,
		};
	}
	return undefined;
}

function streamedText(block: JsonValue): { kind: 'text' | 'reasoning'; text: string } | undefined {
	if (!isRecord(block)) return undefined;
	if (block.type === 'text') return { kind: 'text', text: String(block.text ?? '') };
	if (block.type === 'thinking') return { kind: 'reasoning', text: String(block.thinking ?? '') };
	return undefined;
}

/** Begin a new assistant step of the run `runKey`. */
function startStep(
	state: PiProjectionState,
	runKey: string,
	stepKey: string,
	turnId: string,
	at: number,
	out: Emitter,
): StepState & { runKey: string } {
	const { response } = ensureResponse(state, runKey, at);
	const message = state.messages[response.index] as ConversationUiMessage;
	const step = { key: stepKey, turnId, emitted: {}, partStart: message.parts.length, runKey };
	state.step = step;
	if (response.turnId === undefined) message.turnId = turnId;
	response.turnId = turnId;
	const withMetadata = isRecord(response.startMetadata) && !response.metadataSent;
	out.chunks.push({
		type: 'message-started',
		conversationId: conversationIdOf(state),
		messageId: response.messageId,
		...(response.submissionId !== undefined ? { submissionId: response.submissionId } : {}),
		turnId,
		...(withMetadata
			? { metadata: structuredClone(response.startMetadata) as Record<string, unknown> }
			: {}),
		timestamp: iso(at),
	});
	if (withMetadata) response.metadataSent = true;
	return step;
}

/** Emit the deltas a content array adds over what the step already emitted; returns false on divergence. */
function emitDeltas(
	state: PiProjectionState,
	step: StepState & { runKey: string },
	content: readonly JsonValue[],
	out: Emitter,
): boolean {
	const messageId = state.responses[step.runKey]?.messageId ?? '';
	for (const [index, block] of content.entries()) {
		const streamed = streamedText(block);
		if (!streamed) continue;
		const emitted = step.emitted[String(index)] ?? 0;
		if (streamed.text.length < emitted) return false;
		if (streamed.text.length === emitted) continue;
		out.chunks.push({
			type: 'message-delta',
			conversationId: conversationIdOf(state),
			messageId,
			kind: streamed.kind,
			delta: streamed.text.slice(emitted),
		});
		step.emitted[String(index)] = streamed.text.length;
	}
	return true;
}

/** Replace the step's parts in its response message with `content`. */
function renderStepParts(
	state: PiProjectionState,
	step: StepState & { runKey: string },
	content: readonly JsonValue[],
	streaming: boolean,
): void {
	const response = state.responses[step.runKey];
	if (!response) return;
	const message = state.messages[response.index] as ConversationUiMessage;
	const parts = content.flatMap((block) => {
		const part = partOf(block, streaming);
		return part ? [part] : [];
	});
	message.parts.splice(step.partStart, message.parts.length - step.partStart, ...parts);
}

function onPartial(
	state: PiProjectionState,
	before: LiveValue,
	after: LiveValue,
	at: number,
	out: Emitter,
): void {
	const partial = after.generation?.message;
	const runKey = currentRunKey(after);
	if (!partial || runKey === undefined || after.run === undefined) return;
	if (JSON.stringify(partial) === JSON.stringify(before.generation?.message)) return;
	const content = Array.isArray(partial.content) ? (partial.content as JsonValue[]) : [];
	const stepKey = `${after.run.taskId}:${after.generation?.attempt ?? 0}`;
	let step = state.step;
	if (
		step &&
		step.key !== stepKey &&
		step.runKey === runKey &&
		Object.keys(step.emitted).length > 0
	) {
		// A new attempt replaces a streamed partial: clients must drop what
		// they rendered, which only a reset can retract.
		out.reset = true;
	}
	if (!step || step.key !== stepKey)
		step = startStep(state, runKey, stepKey, `turn_${after.run.taskId}`, at, out);
	if (!emitDeltas(state, step, content, out)) out.reset = true;
	renderStepParts(state, step, content, true);
}

function onAssistant(
	state: PiProjectionState,
	entry: { id: number; byTaskId?: number; model?: JsonValue[] },
	live: LiveValue,
	at: number,
	out: Emitter,
): void {
	const message = (entry.model?.[0] ?? {}) as { content?: JsonValue[] };
	const content = Array.isArray(message.content) ? message.content : [];
	const runKey = currentRunKey(live) ?? state.step?.runKey ?? `e${entry.id}`;
	const taskId = entry.byTaskId ?? live.run?.taskId ?? entry.id;
	let step = state.step;
	if (!step || step.runKey !== runKey || !step.key.startsWith(`${taskId}:`)) {
		step = startStep(state, runKey, `${taskId}:final`, `turn_${taskId}`, at, out);
	}
	if (!emitDeltas(state, step, content, out)) out.reset = true;
	const response = state.responses[runKey] as ResponseState;
	const conversationId = conversationIdOf(state);
	const calls: ToolCallState[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== 'toolCall') continue;
		const callId = String(block.id ?? '');
		calls.push({ callId, name: String(block.name ?? '') });
		out.chunks.push({
			type: 'tool-input',
			conversationId,
			messageId: response.messageId,
			toolCallId: callId,
			toolName: String(block.name ?? ''),
			input: (block.arguments ?? {}) as unknown,
			timestamp: iso(at),
		});
	}
	renderStepParts(state, step, content, false);
	out.chunks.push({
		type: 'message-completed',
		conversationId,
		messageId: response.messageId,
		timestamp: iso(at),
	});
	state.step = undefined;
	if (calls.length > 0) state.round = { runKey, calls };
}

function onToolResult(
	state: PiProjectionState,
	entry: { model?: JsonValue[]; data?: JsonValue },
	at: number,
): void {
	const message = (entry.model?.[0] ?? {}) as {
		toolCallId?: string;
		isError?: boolean;
		content?: { type: string; text?: string }[];
		details?: JsonValue;
	};
	const call = state.round?.calls.find((candidate) => candidate.callId === message.toolCallId);
	if (!call) return;
	const content = Array.isArray(message.content) ? message.content : [];
	const details = isRecord(message.details) ? message.details : undefined;
	const output =
		details && 'output' in details
			? (details.output as JsonValue)
			: (toolResultOutput(content) as JsonValue);
	// An error the tool threw (or the Harness wrote) is an `error` diagnostic;
	// its message is the error text, as Flue reported it before.
	const diagnostics =
		isRecord(entry.data) && Array.isArray(entry.data.diagnostics) ? entry.data.diagnostics : [];
	const errors = diagnostics.flatMap((diagnostic) =>
		isRecord(diagnostic) &&
		diagnostic.severity === 'error' &&
		typeof diagnostic.message === 'string'
			? [diagnostic.message]
			: [],
	);
	const errorText = errors.length > 0 ? errors.join('\n') : toolResultText(content);
	call.result = { isError: message.isError === true, output, errorText, at };
}

function trackSlots(state: PiProjectionState, after: LiveValue, at: number): void {
	if (!state.round) return;
	for (const slot of after.tools ?? []) {
		const call = state.round.calls.find((candidate) => candidate.callId === slot.callId);
		if (call && call.startedAt === undefined && slot.status !== 'pending') call.startedAt = at;
	}
}

function flushRound(state: PiProjectionState, after: LiveValue, out: Emitter, at: number): void {
	const round = state.round;
	if (!round) return;
	const slots = after.tools;
	const open = slots?.some((slot) => slot.status !== 'done') ?? false;
	if (open) return;
	if (round.calls.some((call) => call.result === undefined) && slots !== undefined) return;
	const response = state.responses[round.runKey];
	const message = response ? (state.messages[response.index] as ConversationUiMessage) : undefined;
	const conversationId = conversationIdOf(state);
	for (const call of round.calls) {
		// A call the ended round never ran (an abort mid-round) settles as an
		// error, so no tool part is left waiting for output.
		const result =
			call.result ??
			(slots === undefined
				? {
						isError: true,
						output: null,
						errorText: `Tool ${call.name} did not run: the response ended first.`,
						at,
					}
				: undefined);
		if (!result) continue;
		const durationMs =
			call.startedAt !== undefined ? Math.max(0, result.at - call.startedAt) : undefined;
		out.chunks.push(
			result.isError
				? {
						type: 'tool-output-error',
						conversationId,
						toolCallId: call.callId,
						errorText: result.errorText,
						...(durationMs !== undefined ? { durationMs } : {}),
						timestamp: iso(result.at),
					}
				: {
						type: 'tool-output',
						conversationId,
						toolCallId: call.callId,
						output: result.output,
						...(durationMs !== undefined ? { durationMs } : {}),
						timestamp: iso(result.at),
					},
		);
		if (!message) continue;
		const index = message.parts.findLastIndex(
			(part) =>
				part.type === 'dynamic-tool' &&
				part.toolCallId === call.callId &&
				part.state === 'input-available',
		);
		const part = message.parts[index] as Extract<UiPart, { type: 'dynamic-tool' }> | undefined;
		if (!part) continue;
		message.parts[index] = result.isError
			? {
					type: 'dynamic-tool',
					toolName: part.toolName,
					toolCallId: part.toolCallId,
					state: 'output-error',
					input: part.input,
					errorText: result.errorText,
					...(durationMs !== undefined ? { durationMs } : {}),
				}
			: {
					type: 'dynamic-tool',
					toolName: part.toolName,
					toolCallId: part.toolCallId,
					state: 'output-available',
					input: part.input,
					output: result.output,
					...(durationMs !== undefined ? { durationMs } : {}),
				};
	}
	state.round = undefined;
}

function displayParts(display: DisplayMessage): UiPart[] {
	const parts: UiPart[] = [{ type: 'text', text: display.body, state: 'done' }];
	if (display.kind === 'user') {
		for (const attachment of display.attachments ?? []) {
			parts.push({
				type: 'file',
				mediaType: attachment.mimeType,
				id: attachment.id,
				size: attachment.size,
				...(attachment.filename ? { filename: attachment.filename } : {}),
			});
		}
	}
	return parts;
}

function textOfModel(entry: { model?: JsonValue[] }): string {
	const message = (entry.model?.[0] ?? {}) as { content?: JsonValue };
	if (typeof message.content === 'string') return message.content;
	if (!Array.isArray(message.content)) return '';
	return message.content
		.flatMap((block) =>
			isRecord(block) && block.type === 'text' ? [String(block.text ?? '')] : [],
		)
		.join('');
}

function onUser(
	state: PiProjectionState,
	entry: { id: number; model?: JsonValue[]; data?: JsonValue },
	live: LiveValue,
	at: number,
	out: Emitter,
): void {
	const placed = Object.entries(state.submissions).find(
		([, slot]) => slot.type === 'input' && slot.conversationId === ROOT && slot.entry === entry.id,
	);
	const submissionId = placed?.[1].requestId;
	const receipt = receiptOf(state, submissionId);
	const display = receipt?.message;
	const runKey = currentRunKey(live);
	// A delivery placed into a run that another input started joined it.
	const joined = placed !== undefined && runKey !== undefined && runKey !== placed[0];
	const turnId = joined && runKey !== undefined ? state.responses[runKey]?.turnId : undefined;
	let message: ConversationUiMessage;
	if (display?.kind === 'signal') {
		const signal = {
			...(display.tagName ? { tagName: display.tagName } : {}),
			...(display.attributes ? { attributes: display.attributes } : {}),
		};
		message = {
			id: `msg_${entry.id}`,
			role: 'system',
			purpose: 'dispatch',
			display: 'diagnostic',
			...(submissionId !== undefined ? { submissionId } : {}),
			...(turnId !== undefined ? { turnId } : {}),
			...(Object.keys(signal).length > 0 ? { signal } : {}),
			timestamp: iso(at),
			parts: displayParts(display),
		};
	} else if (display?.kind === 'user') {
		message = {
			id: `msg_${entry.id}`,
			role: 'user',
			purpose: 'user',
			display: 'visible',
			...(submissionId !== undefined ? { submissionId } : {}),
			...(turnId !== undefined ? { turnId } : {}),
			timestamp: iso(at),
			parts: displayParts(display),
		};
	} else {
		// Runtime-authored input (an `useAgentFinish` continuation): diagnostic.
		message = {
			id: `msg_${entry.id}`,
			role: 'system',
			purpose: 'dispatch',
			display: 'diagnostic',
			timestamp: iso(at),
			parts: [{ type: 'text', text: textOfModel(entry), state: 'done' }],
		};
	}
	state.messages.push(message);
	out.chunks.push({
		type: 'message-appended',
		conversationId: conversationIdOf(state),
		message: structuredClone(message),
	});
}

function anchorResponse(state: PiProjectionState, live: LiveValue): ResponseState | undefined {
	const runKey = currentRunKey(live) ?? state.round?.runKey ?? state.step?.runKey;
	if (runKey !== undefined && state.responses[runKey]) return state.responses[runKey];
	const responses = Object.values(state.responses);
	return responses.reduce<ResponseState | undefined>(
		(latest, candidate) =>
			latest === undefined || candidate.index > latest.index ? candidate : latest,
		undefined,
	);
}

function onData(
	state: PiProjectionState,
	entry: { data?: JsonValue },
	live: LiveValue,
	out: Emitter,
): void {
	const data = isRecord(entry.data) ? entry.data : undefined;
	const response = anchorResponse(state, live);
	if (!data || typeof data.name !== 'string' || !response) return;
	const message = state.messages[response.index] as ConversationUiMessage;
	const parts = state.dataParts[message.id] ?? {};
	state.dataParts[message.id] = parts;
	const existing = parts[data.name];
	const part: UiPart = { type: `data-${data.name}`, data: structuredClone(data.data) };
	if (existing !== undefined && message.parts[existing]) message.parts[existing] = part;
	else {
		message.parts.push(part);
		parts[data.name] = message.parts.length - 1;
	}
	out.chunks.push({
		type: 'data-part',
		conversationId: conversationIdOf(state),
		messageId: message.id,
		name: data.name,
		data: structuredClone(data.data),
	});
}

function onMetadata(state: PiProjectionState, entry: { data?: JsonValue }, out: Emitter): void {
	const data = isRecord(entry.data) ? entry.data : undefined;
	if (!data || typeof data.run !== 'string' || !isRecord(data.metadata)) return;
	const response = state.responses[data.run];
	if (!response) return;
	const message = state.messages[response.index] as ConversationUiMessage;
	const delta = metadataDelta(data.metadata, response.startMetadata);
	const merged = (message.metadata ?? {}) as { [key: string]: JsonValue };
	deepMerge(merged, data.metadata);
	message.metadata = merged;
	if (Object.keys(delta).length === 0) return;
	out.chunks.push({
		type: 'message-metadata',
		conversationId: conversationIdOf(state),
		messageId: response.messageId,
		metadata: delta,
	});
}

type SettlementOutcome = {
	outcome: Settlement['outcome'];
	error?: unknown;
	advisory?: {
		type: 'submission_aborted' | 'submission_interrupted';
		reason: string;
		text: string;
	};
};

function settlementOf(slot: SubmissionSlot, receipt: ReceiptValue | undefined): SettlementOutcome {
	if (receipt?.classification === 'exceeded_timeout') {
		const error = new SubmissionTimeoutError();
		return {
			outcome: 'failed',
			error: serializeSubmissionError(error),
			advisory: { type: 'submission_interrupted', reason: 'exceeded_timeout', text: error.message },
		};
	}
	if (receipt?.classification === 'exhausted_retry_budget') {
		const error = new SubmissionRetryExhaustedError({
			attemptCount: receipt.attempts ?? 0,
			maxAttempts: receipt.maxAttempts ?? 0,
		});
		return {
			outcome: 'failed',
			error: serializeSubmissionError(error),
			advisory: {
				type: 'submission_interrupted',
				reason: 'exhausted_retry_budget',
				text: error.message,
			},
		};
	}
	if (slot.status === 'unanswered' && slot.reason === 'aborted') {
		const error = new SubmissionAbortedError();
		return {
			outcome: 'aborted',
			error: serializeSubmissionError(error),
			advisory: { type: 'submission_aborted', reason: 'aborted', text: error.message },
		};
	}
	if (slot.status === 'unanswered') {
		return {
			outcome: 'failed',
			error: serializeSubmissionError(
				new Error(`Submission ended without an answer: ${slot.reason}`),
			),
		};
	}
	return { outcome: 'completed' };
}

function onSettled(
	state: PiProjectionState,
	settledIds: readonly string[],
	before: LiveValue,
	at: number,
	out: Emitter,
): void {
	const host = before.run?.inputs[0];
	// Joined deliveries settle before the input that hosts their answer, as before.
	const ordered = [...settledIds].sort((left, right) => {
		const leftHost = Number(left) === host ? 1 : 0;
		const rightHost = Number(right) === host ? 1 : 0;
		return leftHost - rightHost || Number(left) - Number(right);
	});
	const conversationId = conversationIdOf(state);
	for (const id of ordered) {
		const slot = state.submissions[id];
		const submissionId = slot?.requestId;
		if (!slot || submissionId === undefined || state.settled[submissionId]) continue;
		const receipt = receiptOf(state, submissionId);
		if (!receipt) continue;
		state.settled[submissionId] = true;
		const settled = settlementOf(slot, receipt);
		const runKey = state.runOf[id];
		const hostId = runKey !== undefined ? state.submissions[runKey]?.requestId : undefined;
		const answeredBySubmissionId = hostId ?? submissionId;
		if (settled.advisory) {
			const advisory: ConversationUiMessage = {
				id: `adv_${submissionId}`,
				role: 'system',
				purpose: 'advisory',
				display: 'diagnostic',
				signal: {
					attributes: {
						submissionId,
						kind: receipt.kind ?? 'dispatch',
						reason: settled.advisory.reason,
					},
				},
				settlement: { outcome: settled.outcome === 'aborted' ? 'aborted' : 'failed' },
				timestamp: iso(at),
				parts: [{ type: 'text', text: settled.advisory.text, state: 'done' }],
			};
			state.messages.push(advisory);
			out.chunks.push({
				type: 'message-appended',
				conversationId,
				message: structuredClone(advisory),
			});
		}
		const settlement: Settlement = {
			submissionId,
			outcome: settled.outcome,
			...(settled.error !== undefined ? { error: settled.error } : {}),
			answeredBySubmissionId,
			timestamp: iso(at),
		};
		state.settlements.push(settlement);
		out.chunks.push({ type: 'submission-settled', conversationId, ...settlement });
	}
}

/** Fold one envelope into `state` (mutated) and return its chunks. */
export function projectPiCommitInPlace(
	state: PiProjectionState,
	envelope: PiCommitEnvelope,
): ConversationStreamChunk[] {
	state.storage ??= envelope.storage;
	state.seq = envelope.seq;
	const at = envelope.at;
	const out: Emitter = { chunks: [], reset: false };
	const before = liveOf(state);
	foldDocuments(state, envelope.writes);
	const after = liveOf(state);

	let created = false;
	const entries: {
		id: number;
		kind: string;
		model?: JsonValue[];
		data?: JsonValue;
		byTaskId?: number;
	}[] = [];
	const settledIds: string[] = [];
	for (const write of envelope.writes) {
		if (write.type === 'conversation' && write.value.id === ROOT && !state.rootCreated) {
			state.rootCreated = true;
			created = true;
		} else if (write.type === 'entry' && write.value.conversationId === ROOT) {
			entries.push(write.value as unknown as (typeof entries)[number]);
		} else if (write.type === 'submission') {
			const value = write.value;
			const id = String(value.id);
			const previous = state.submissions[id];
			state.submissions[id] = {
				type: value.type,
				conversationId: value.conversationId,
				...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
				status: value.status,
				...(value.entry !== undefined ? { entry: value.entry } : {}),
				...(value.answer !== undefined ? { answer: value.answer } : {}),
				...(value.reason !== undefined ? { reason: value.reason } : {}),
				...(value.detail !== undefined ? { detail: value.detail } : {}),
			};
			const terminal = value.status === 'done' || value.status === 'unanswered';
			const wasTerminal = previous?.status === 'done' || previous?.status === 'unanswered';
			if (value.type === 'input' && value.conversationId === ROOT && terminal && !wasTerminal)
				settledIds.push(id);
		}
	}
	entries.sort((left, right) => left.id - right.id);

	// Run membership: every input of a run answers with the run's first input.
	for (const live of [before, after]) {
		const runKey = currentRunKey(live);
		if (runKey === undefined) continue;
		for (const input of live.run?.inputs ?? []) state.runOf[String(input)] ??= runKey;
	}

	if (created) out.reset = true;
	const imported = entries.find((entry) => entry.kind === ENTRY_IMPORT);
	if (imported) {
		// A pre-upgrade conversation: its legacy projection is the history.
		const data = isRecord(imported.data) ? imported.data : {};
		state.messages = Array.isArray(data.messages) ? (structuredClone(data.messages) as never) : [];
		state.settlements = Array.isArray(data.settlements)
			? (structuredClone(data.settlements) as never)
			: [];
		for (const settlement of state.settlements) state.settled[settlement.submissionId] = true;
		out.reset = true;
		entries.length = 0;
	}
	trackSlots(state, after, at);
	onPartial(state, before, after, at, out);
	for (const entry of entries) {
		switch (entry.kind) {
			case ENTRY_USER:
				onUser(state, entry, after.run ? after : before, at, out);
				break;
			case ENTRY_ASSISTANT:
				onAssistant(state, entry, before.run ? before : after, at, out);
				break;
			case ENTRY_TOOL_RESULT:
				onToolResult(state, entry, at);
				break;
			case ENTRY_DATA:
				onData(state, entry, after.run ? after : before, out);
				break;
			case ENTRY_METADATA:
				onMetadata(state, entry, out);
				break;
			case ENTRY_COMPACTION:
				out.reset = true;
				break;
			default:
				break;
		}
	}
	trackSlots(state, after, at);
	flushRound(state, after, out, at);
	onSettled(state, settledIds, before, at, out);

	if (out.reset) {
		const snapshot = projectPiSnapshot(state);
		return snapshot
			? [
					{
						type: 'conversation-reset',
						conversationId: snapshot.conversationId,
						snapshot,
						position: { batch: envelope.seq, index: 0 },
					},
				]
			: [];
	}
	return out.chunks.map(
		(chunk, index) =>
			({ ...chunk, position: { batch: envelope.seq, index } }) as ConversationStreamChunk,
	);
}

/** Fold one envelope into a copy of `state`. */
export function projectPiCommit(
	state: PiProjectionState,
	envelope: PiCommitEnvelope,
): { state: PiProjectionState; chunks: ConversationStreamChunk[] } {
	const next = cloneProjectionState(state);
	const chunks = projectPiCommitInPlace(next, envelope);
	return { state: next, chunks };
}

/** The public snapshot of the folded state, or `undefined` before the root conversation exists. */
export function projectPiSnapshot(
	state: PiProjectionState,
	offset?: string,
): AgentConversationSnapshot | undefined {
	if (!state.rootCreated) return undefined;
	return {
		v: 1,
		conversationId: conversationIdOf(state),
		offset: offset ?? '',
		messages: structuredClone(state.messages),
		settlements: structuredClone(state.settlements),
	};
}

/**
 * Message ids that can still receive live chunks: the response of every run
 * with an unsettled input, and the response streaming now. A bounded history
 * window must keep them (`conversation-history-window.ts`).
 */
export function projectPiLiveTargets(state: PiProjectionState): ReadonlySet<string> {
	const targets = new Set<string>();
	for (const [submissionId, runKey] of Object.entries(state.runOf)) {
		const requestId = state.submissions[submissionId]?.requestId;
		if (requestId !== undefined && state.settled[requestId]) continue;
		const response = state.responses[runKey];
		if (response) targets.add(response.messageId);
	}
	if (state.step) {
		const response = state.responses[state.step.runKey];
		if (response) targets.add(response.messageId);
	}
	return targets;
}
