/**
 * Flue lifecycle hooks on Pi `GenerationHooks` (PI_UPGRADE_PLAN.md §1
 * `hooks/use-agent-*`/`use-response-*` rows, §3 attachments row).
 *
 * A Pi run spans several generation tasks (one per tool round), so per-task
 * memos cannot carry run state. Bookkeeping lives in the conversation's
 * `flue.runs` document, keyed by the run's first input submission, and is
 * written through the host's Session line (hooks themselves only read):
 *
 * - `useAgentStart` runs once per delivered input (each input in
 *   `pi.live.run.inputs`, steers included) before its first request; the
 *   signals it appends are injected into every request of the run.
 * - `useResponseStart` runs once per run; `useResponseFinish` at the final
 *   answer. Their metadata lands as a `flue.metadata` entry through a write
 *   submission, which the answer's final boundary places.
 * - `useAgentFinish` runs at every would-stop (`onYield`); appended signals
 *   become the continuation, bounded by `MAX_AGENT_FINISH_CONTINUATIONS`.
 *
 * All callbacks are at-least-once per delivery, as in Flue: a crash between
 * running a callback and recording it reruns it on recovery.
 *
 * `beforeRequest` also rehydrates `flue-attachment:<id>` placeholders in user
 * content, so attachment bytes never enter the canonical log.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	UserMessage,
} from '@earendil-works/pi-ai';
import {
	type ConversationId,
	type EntryDraft,
	type GenerationHooks,
	type HookApi,
	LiveDoc,
	type Tx,
} from '@earendil-works/pi-durable';
import {
	type AgentAppendMessage,
	type AgentFinishDeclaration,
	type AgentResponseToolCall,
	type AgentStartDeclaration,
	assertAppendMessage,
	type ResponseFinishDeclaration,
	type ResponseStartDeclaration,
} from '../message-output.ts';
import { renderSignalMessage } from '../message-rendering.ts';
import type { FlueHarness, FlueLogger, PromptUsage } from '../types.ts';
import { FlueMetadataEntry, FlueRuns, type FlueRunState } from './docs.ts';

/** Defense-in-depth ceiling on `useAgentFinish` continuations per run (Flue's value). */
export const MAX_AGENT_FINISH_CONTINUATIONS = 20;

/** Prefix of an attachment placeholder in canonical user content. */
export const ATTACHMENT_PLACEHOLDER_PREFIX = 'flue-attachment:';

/** The lifecycle declarations of one render. */
export interface FlueLifecycle {
	readonly agentStarts: readonly AgentStartDeclaration[];
	readonly agentFinishes: readonly AgentFinishDeclaration[];
	readonly responseStarts: readonly ResponseStartDeclaration[];
	readonly responseFinishes: readonly ResponseFinishDeclaration[];
}

/** Attachment bytes behind placeholders; the attachment store stays Flue's. */
export interface FlueAttachmentPort {
	/** Persist one attachment of a submission and return its id (the placeholder target). */
	put(
		submissionId: string,
		index: number,
		attachment: { readonly data: string; readonly mimeType: string; readonly filename?: string },
	): Promise<string>;
	/** Base64 bytes of a stored attachment. */
	get(id: string): Promise<{ readonly data: string; readonly mimeType: string } | undefined>;
}

export interface LifecycleHookDeps {
	/** Declarations governing a conversation (root agent only; delegates have none). */
	lifecycle(
		conversationId: ConversationId,
		api: HookApi,
		context: Context,
	): Promise<FlueLifecycle | undefined>;
	/** One Session commit on the host's Harness. */
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	/** Admit a passive write into a conversation (placed at its next boundary). */
	write(
		conversationId: ConversationId,
		entry: EntryDraft,
		requestId: string,
		context: Context,
	): Promise<void>;
	readonly attachments?: FlueAttachmentPort;
	/** `ctx.harness` of lifecycle callbacks; absent until the cutover wires it. */
	readonly harness?: (conversationId: ConversationId, context: Context) => FlueHarness;
	readonly logger?: (hook: string) => FlueLogger;
	readonly now: () => number;
	readonly onReport: (error: unknown) => void;
}

const NOOP_LOGGER: FlueLogger = { info: () => {}, warn: () => {}, error: () => {} };

function emptyUsage(): PromptUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addAssistantUsage(total: PromptUsage, message: AssistantMessage): void {
	const usage = message.usage;
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** Tool calls and usage of the run so far: the messages after the run's anchor, plus the answer. */
function responseAggregates(
	messages: readonly Message[],
	anchor: number,
	answer: AssistantMessage | undefined,
): { toolCalls: AgentResponseToolCall[]; usage: PromptUsage } {
	const toolCalls: AgentResponseToolCall[] = [];
	const usage = emptyUsage();
	for (const message of messages.slice(Math.min(anchor, messages.length))) {
		if (message.role === 'toolResult')
			toolCalls.push({ tool: message.toolName, isError: message.isError });
		if (message.role === 'assistant') addAssistantUsage(usage, message);
	}
	if (answer) addAssistantUsage(usage, answer);
	return { toolCalls, usage };
}

function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	for (const [key, value] of Object.entries(source)) {
		const existing = target[key];
		if (
			value !== null &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			existing !== null &&
			typeof existing === 'object' &&
			!Array.isArray(existing)
		) {
			target[key] = deepMerge(
				{ ...(existing as Record<string, unknown>) },
				value as Record<string, unknown>,
			);
		} else {
			target[key] = value;
		}
	}
	return target;
}

function signalText(append: AgentAppendMessage): string {
	const signal = assertAppendMessage(append);
	return renderSignalMessage({
		role: 'signal',
		type: signal.type,
		content: signal.body,
		...(signal.attributes ? { attributes: signal.attributes } : {}),
		...(signal.tagName ? { tagName: signal.tagName } : {}),
		timestamp: 0,
	});
}

/** Collects `ctx.append` calls, legal only while the callback runs. */
function appendWindow(): { append: (message: AgentAppendMessage) => void; close(): string[] } {
	const collected: string[] = [];
	let open = true;
	return {
		append(message) {
			if (!open)
				throw new Error('[flue] append() was called after its lifecycle callback settled.');
			collected.push(signalText(message));
		},
		close() {
			open = false;
			return collected;
		},
	};
}

function lazyHarness(
	deps: LifecycleHookDeps,
	conversationId: ConversationId,
	context: Context,
): FlueHarness {
	let harness: FlueHarness | undefined;
	return new Proxy({} as FlueHarness, {
		get(_target, property) {
			if (!deps.harness) {
				throw new Error(
					'[flue] ctx.harness is not available on this Pi host yet (coordinator cutover).',
				);
			}
			harness ??= deps.harness(conversationId, context);
			return Reflect.get(harness, property);
		},
	});
}

/** Replace `flue-attachment:<id>` image placeholders with their stored bytes, request-only. */
export async function rehydrateAttachments(
	messages: readonly Message[],
	port: FlueAttachmentPort | undefined,
): Promise<readonly Message[] | undefined> {
	if (!port) return undefined;
	let changed = false;
	const next: Message[] = [];
	for (const message of messages) {
		if (message.role !== 'user' || typeof message.content === 'string') {
			next.push(message);
			continue;
		}
		const content: (TextContent | ImageContent)[] = [];
		for (const block of message.content) {
			if (block.type === 'image' && block.data.startsWith(ATTACHMENT_PLACEHOLDER_PREFIX)) {
				const stored = await port.get(block.data.slice(ATTACHMENT_PLACEHOLDER_PREFIX.length));
				if (stored) {
					// Keep the carrier's other fields (a document's `filename`).
					content.push({ ...block, data: stored.data, mimeType: stored.mimeType });
					changed = true;
					continue;
				}
			}
			content.push(block);
		}
		next.push({ ...message, content });
	}
	return changed ? next : undefined;
}

function signalMessages(texts: readonly string[], timestamp: number): UserMessage[] {
	return texts.map((text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp }));
}

/** Build the Flue `GenerationHooks` for one host. */
export function lifecycleHooks(deps: LifecycleHookDeps): Partial<GenerationHooks> {
	/**
	 * Latest request messages per conversation, for the `onYield` aggregates. A
	 * conversation runs one generation at a time, and `onYield` always follows
	 * its own request in the same invocation, so the entry is never stale.
	 */
	const lastRequest = new Map<number, readonly Message[]>();

	const runKeyOf = async (api: HookApi, context: Context) => {
		const live = await api.snapshot(LiveDoc, api.conversationId, context);
		const inputs = live?.run?.inputs ?? [];
		const first = inputs[0];
		return first === undefined ? undefined : { key: String(first), inputs: inputs.map(Number) };
	};

	const updateRun = (
		conversationId: ConversationId,
		key: string,
		update: (run: FlueRunState) => void,
		context: Context,
	) =>
		deps.commit(async (tx) => {
			const doc = await tx.doc(FlueRuns, conversationId);
			// Assign first, then re-read: the draft only tracks writes made through it.
			if (doc.runs[key] === undefined) {
				doc.runs[key] = { started: [], appends: [], anchor: 0, metadata: {}, continuations: 0 };
			}
			const run = doc.runs[key];
			if (run) update(run as FlueRunState);
		}, context);

	return {
		async beforeRequest(request, api, context) {
			let messages =
				(await rehydrateAttachments(request.messages, deps.attachments)) ?? request.messages;
			const lifecycle = await deps.lifecycle(api.conversationId, api, context);
			const run = lifecycle ? await runKeyOf(api, context) : undefined;
			if (lifecycle && run) {
				const runs = await api.snapshot(FlueRuns, api.conversationId, context);
				let state = runs?.runs[run.key];
				const pending = run.inputs.filter((input) => !state?.started.includes(input));
				if (pending.length > 0) {
					const signal = context.abortSignal ?? new AbortController().signal;
					const appended: string[] = [];
					for (const _input of pending) {
						for (const declaration of lifecycle.agentStarts) {
							const window = appendWindow();
							try {
								await declaration.run({
									append: window.append,
									harness: lazyHarness(deps, api.conversationId, context),
									log: deps.logger?.('useAgentStart') ?? NOOP_LOGGER,
									signal,
								});
							} finally {
								appended.push(...window.close());
							}
						}
					}
					let metadata: Record<string, unknown> | undefined;
					if (state === undefined && lifecycle.responseStarts.length > 0) {
						metadata = {};
						for (const declaration of lifecycle.responseStarts) {
							const returned = declaration.run({
								metadata: { ...metadata },
								log: deps.logger?.('useResponseStart') ?? NOOP_LOGGER,
							});
							if (returned) deepMerge(metadata, returned);
						}
					}
					const anchor = state?.anchor ?? messages.length;
					await updateRun(
						api.conversationId,
						run.key,
						(record) => {
							for (const input of pending)
								if (!record.started.includes(input)) record.started.push(input);
							record.appends.push(...appended);
							if (state === undefined) record.anchor = anchor;
							if (metadata) deepMerge(record.metadata as Record<string, unknown>, metadata);
						},
						context,
					);
					state = {
						started: [...(state?.started ?? []), ...pending],
						appends: [...(state?.appends ?? []), ...appended],
						anchor,
						metadata: (state?.metadata ?? {}) as FlueRunState['metadata'],
						continuations: state?.continuations ?? 0,
					};
				}
				if (state && state.appends.length > 0) {
					const at = Math.min(state.anchor, messages.length);
					messages = [
						...messages.slice(0, at),
						...signalMessages(state.appends, deps.now()),
						...messages.slice(at),
					];
				}
			}
			lastRequest.set(api.conversationId, messages);
			return messages === request.messages ? undefined : { messages };
		},

		async onYield(answer, api, context) {
			const lifecycle = await deps.lifecycle(api.conversationId, api, context);
			if (!lifecycle) return undefined;
			if (lifecycle.agentFinishes.length === 0 && lifecycle.responseFinishes.length === 0)
				return undefined;
			const run = await runKeyOf(api, context);
			if (!run) return undefined;
			const runs = await api.snapshot(FlueRuns, api.conversationId, context);
			const state = runs?.runs[run.key];
			const messages = lastRequest.get(api.conversationId) ?? [];
			const response = responseAggregates(messages, state?.anchor ?? messages.length, answer);
			const signal = context.abortSignal ?? new AbortController().signal;

			const appended: string[] = [];
			for (const declaration of lifecycle.agentFinishes) {
				const window = appendWindow();
				try {
					await declaration.run({
						response,
						append: window.append,
						harness: lazyHarness(deps, api.conversationId, context),
						log: deps.logger?.('useAgentFinish') ?? NOOP_LOGGER,
						signal,
					});
				} finally {
					appended.push(...window.close());
				}
			}
			if (appended.length > 0 && (state?.continuations ?? 0) < MAX_AGENT_FINISH_CONTINUATIONS) {
				await updateRun(
					api.conversationId,
					run.key,
					(record) => {
						record.continuations += 1;
					},
					context,
				);
				return { continue: appended.map((text) => ({ type: 'text' as const, text })) };
			}
			if (appended.length > 0) {
				deps.onReport(
					new Error(
						`[flue] useAgentFinish appended past the ${MAX_AGENT_FINISH_CONTINUATIONS}-continuation ceiling; the response ends here.`,
					),
				);
			}

			const metadata: Record<string, unknown> = {
				...((state?.metadata ?? {}) as Record<string, unknown>),
			};
			for (const declaration of lifecycle.responseFinishes) {
				const returned = declaration.run({
					metadata: { ...metadata },
					response,
					log: deps.logger?.('useResponseFinish') ?? NOOP_LOGGER,
				});
				if (returned) deepMerge(metadata, returned);
			}
			if (Object.keys(metadata).length > 0) {
				await deps.write(
					api.conversationId,
					{ kind: FlueMetadataEntry.kind, data: { run: run.key, metadata: metadata as JsonValue } },
					`flue.metadata:${run.key}`,
					context,
				);
			}
			return undefined;
		},
	};
}
