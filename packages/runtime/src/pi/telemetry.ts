/**
 * Flue's runtime events and execution interception on Pi Durable
 * (PI_UPGRADE_PLAN.md §1 telemetry row): `observe()` subscribers, the
 * OpenTelemetry and Cloudflare tracing backends, and the dev logger keep
 * receiving the `FlueEvent`s they always did.
 *
 * - Model turns: the Harness's `Models` is wrapped, so every provider call
 *   emits `turn_start` / `turn_request` / the streaming deltas / `turn`, runs
 *   inside the `model` execution interception, and gets Flue's document
 *   attachment rewriting and dynamic-model resolution. A generation
 *   `beforeRequest` hook (registered last) names the turn and its
 *   conversation; the provider call finds it by the invocation's signal.
 * - Everything else is read off committed Pi state through
 *   `subscribeCommits`: tool slots (`tool_start` / `tool`), runs
 *   (`operation_start` / `operation`), compactions, and Flue submissions
 *   (`submission_running` / `submission_settled`).
 *
 * Events are live-only and at-least-once across recovery, as before.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import type {
	AssistantMessage,
	Context as ModelContext,
	Message,
	Model,
	Models,
	SimpleStreamOptions,
	ToolResultMessage,
	UserMessage,
} from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import type {
	CommitPublication,
	GenerationHooks,
	Harness,
	HookApi,
} from '@earendil-works/pi-durable';
import { prepareDocumentRequest } from '../document-attachments.ts';
import { classifyError } from '../errors.ts';
import { IMAGE_DATA_OMITTED } from '../event-redaction.ts';
import { type FlueExecutionContext, interceptExecution } from '../execution-interceptor.ts';
import { readProviderResponseDiagnostics } from '../provider-diagnostics.ts';
import { serializeSubmissionError } from '../runtime/submission-errors.ts';
import { providerTelemetryName } from '../runtime/providers.ts';
import type {
	FlueEvent,
	FlueEventInput,
	FlueObservationDetail,
	ModelRequestInfo,
} from '../types.ts';
import { fromProviderUsage } from '../usage.ts';

type TurnInputMessage = Extract<
	FlueEvent,
	{ type: 'turn_request' }
>['request']['input']['messages'][number];
type TurnInputTool = NonNullable<
	Extract<FlueEvent, { type: 'turn_request' }>['request']['input']['tools']
>[number];
type TurnOutput = NonNullable<Extract<FlueEvent, { type: 'turn' }>['response']['output']>;

/** Pi's reserved root conversation id: Flue's default session. */
const ROOT = 1;

export interface PiTelemetryOptions {
	/** Publish one event on the instance's event context. */
	readonly emit: (event: FlueEventInput, observation?: FlueObservationDetail) => void;
	/** Execution context for interceptors (tracing). */
	readonly executionContext: (fields: Partial<FlueExecutionContext>) => FlueExecutionContext;
	/** Resolve a model Pi's `Models` does not list (Flue's dynamic models). */
	readonly resolveModel?: (provider: string, modelId: string) => Model<string> | undefined;
	readonly now?: () => number;
}

/** The correlation fields telemetry stamps on its events. */
type EventScope = {
	session?: string;
	harness?: string;
	conversationId?: string;
	submissionId?: string;
};

interface TurnContext {
	readonly turnId: string;
	readonly conversationId: number;
	readonly submissionId?: string;
}

type LiveValue = {
	run?: { taskId: number; inputs: number[] };
	tools?: { callId: string; name: string; status: string; entry?: number }[];
	compactions?: { taskId: number; reason: 'threshold' | 'overflow' | 'manual' }[];
};

type ReceiptValue = {
	status?: string;
	kind?: 'dispatch' | 'direct';
	attempts?: number;
	maxAttempts?: number;
	classification?: 'exceeded_timeout' | 'exhausted_retry_budget';
};

function parseEndpoint(value: string | undefined): { address: string; port?: number } | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return { address: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) };
	} catch {
		return undefined;
	}
}

type ContentBlock =
	| Exclude<UserMessage['content'], string>[number]
	| AssistantMessage['content'][number]
	| ToolResultMessage['content'][number];

function turnContent(block: ContentBlock): unknown {
	if (block.type === 'text')
		return { type: 'text', text: block.text, textSignature: block.textSignature };
	if (block.type === 'image')
		return { type: 'image', data: IMAGE_DATA_OMITTED, mimeType: block.mimeType };
	if (block.type === 'thinking') {
		return {
			type: 'thinking',
			thinking: block.thinking,
			thinkingSignature: block.thinkingSignature,
			redacted: block.redacted,
		};
	}
	return {
		type: 'toolCall',
		id: block.id,
		name: block.name,
		arguments: block.arguments,
		thoughtSignature: block.thoughtSignature,
	};
}

function turnMessage(message: Message): TurnInputMessage | undefined {
	if (message.role === 'user') {
		return {
			role: 'user',
			content:
				typeof message.content === 'string'
					? message.content
					: (message.content.map(turnContent) as never),
		} as TurnInputMessage;
	}
	if (message.role === 'assistant') {
		return { role: 'assistant', content: message.content.map(turnContent) } as TurnInputMessage;
	}
	if (message.role === 'toolResult') {
		return {
			role: 'toolResult',
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content.map(turnContent),
			isError: message.isError,
		} as TurnInputMessage;
	}
	return undefined;
}

function requestInfo(
	model: Model<string>,
	options: SimpleStreamOptions | undefined,
): ModelRequestInfo {
	const endpoint = parseEndpoint(model.baseUrl);
	return {
		providerId: model.provider,
		providerName: providerTelemetryName(model.provider),
		requestedModel: model.id,
		api: model.api,
		serverAddress: endpoint?.address,
		serverPort: endpoint?.port,
		reasoningLevel: options?.reasoning,
		maxTokens: options?.maxTokens,
		temperature: options?.temperature,
	};
}

export class PiTelemetry {
	readonly #options: PiTelemetryOptions;
	readonly #now: () => number;
	readonly #turns = new WeakMap<AbortSignal, TurnContext>();
	readonly #turnCounts = new Map<number, number>();
	/** Last committed `pi.live` value per conversation. */
	readonly #live = new Map<number, LiveValue>();
	readonly #receipts = new Map<string, ReceiptValue>();
	/** Pi submission id → Flue submission id (root inputs). */
	readonly #flueIds = new Map<number, string>();
	readonly #toolStarts = new Map<string, { at: number; args: JsonValue | undefined }>();
	readonly #toolArgs = new Map<string, JsonValue>();
	readonly #runs = new Map<string, number>();
	/** Latest answer text per conversation, for the run's `agentOutput`. */
	readonly #answers = new Map<number, { text: string; finishReason: string }>();
	/** Latest user input text per conversation, for the run's `agentInput`. */
	readonly #inputs = new Map<number, string>();
	/** Settled inputs of this commit that did not end `done`. */
	#failedInputs = new Set<number>();
	readonly #compactions = new Map<number, number>();

	constructor(options: PiTelemetryOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	// ─── Models ──────────────────────────────────────────────────────────────

	/** `inner` with Flue's turn events, interception, document rewriting and dynamic models. */
	models(inner: Models): Models {
		const telemetry = this;
		return new Proxy(inner, {
			get(target, property, receiver) {
				if (property === 'getModel') {
					return (provider: string, modelId: string) =>
						target.getModel(provider, modelId) ??
						telemetry.#options.resolveModel?.(provider, modelId);
				}
				if (property === 'streamSimple') {
					return (model: Model<string>, context: ModelContext, options?: SimpleStreamOptions) =>
						telemetry.#stream(target, model, context, options, 'agent');
				}
				if (property === 'completeSimple') {
					return async (
						model: Model<string>,
						context: ModelContext,
						options?: SimpleStreamOptions,
					) => {
						const stream = telemetry.#stream(target, model, context, options, 'compaction');
						return stream.result();
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	#stream(
		models: Models,
		model: Model<string>,
		requestContext: ModelContext,
		requestOptions: SimpleStreamOptions | undefined,
		purpose: 'agent' | 'compaction',
	): ReturnType<Models['streamSimple']> {
		const { context, options } = prepareDocumentRequest(
			model as never,
			requestContext,
			requestOptions,
		);
		const turn =
			(requestOptions?.signal ? this.#turns.get(requestOptions.signal) : undefined) ??
			({ turnId: `turn_${crypto.randomUUID()}`, conversationId: 0 } satisfies TurnContext);
		const decoration = this.#decoration(turn);
		const info = requestInfo(model, options);
		const startedAt = this.#now();
		this.#options.emit({ type: 'turn_start', turnId: turn.turnId, purpose, ...decoration });
		const messages = context.messages as Message[];
		const tools = (context.tools ?? getCurrentTools(messages)).map(
			(tool): TurnInputTool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			}),
		);
		this.#options.emit({
			type: 'turn_request',
			turnId: turn.turnId,
			purpose,
			request: {
				...info,
				input: {
					systemPrompt: context.systemPrompt ?? getCurrentSystemPrompt(messages),
					messages: messages.flatMap((message) => {
						const projected = turnMessage(message);
						return projected ? [projected] : [];
					}),
					tools,
				},
			},
			...decoration,
		});
		const operation = { type: 'model' as const, turnId: turn.turnId };
		const execution = this.#options.executionContext({
			turnId: turn.turnId,
			...(turn.submissionId !== undefined ? { submissionId: turn.submissionId } : {}),
		});
		const stream = models.streamSimple(model as never, context, options);
		const emitTurn = (response: AssistantMessage | undefined, error?: unknown) => {
			const output = response ? (turnMessage(response) as TurnOutput | undefined) : undefined;
			const diagnostics = response ? readProviderResponseDiagnostics(response) : undefined;
			this.#options.emit({
				type: 'turn',
				turnId: turn.turnId,
				purpose,
				durationMs: this.#now() - startedAt,
				request: info,
				response: {
					responseId: response?.responseId,
					responseModel: response?.responseModel,
					...(output ? { output } : {}),
					usage: fromProviderUsage(response?.usage),
					finishReason: response?.stopReason,
					...diagnostics,
					...(error !== undefined || response?.errorMessage
						? { error: classifyError(error ?? response?.errorMessage) }
						: {}),
				},
				isError:
					error !== undefined ||
					response?.stopReason === 'error' ||
					response?.stopReason === 'aborted',
				...decoration,
			});
		};
		const emit = this.#options.emit;
		let settled = false;
		const finish = (response: AssistantMessage | undefined, error?: unknown) => {
			if (settled) return;
			settled = true;
			emitTurn(response, error);
		};
		return {
			[Symbol.asyncIterator]() {
				const iterator = stream[Symbol.asyncIterator]();
				return {
					async next() {
						const result = await interceptExecution(operation, execution, () => iterator.next());
						if (!result.done) {
							const event = result.value as { type: string; delta?: string; contentIndex?: number };
							if (event.type === 'text_delta' && event.delta)
								emit({ type: 'text_delta', text: event.delta, ...decoration });
							else if (event.type === 'thinking_delta' && event.delta) {
								emit({
									type: 'thinking_delta',
									contentIndex: event.contentIndex,
									delta: event.delta,
									...decoration,
								});
							}
						}
						return result;
					},
					return: iterator.return?.bind(iterator),
					throw: iterator.throw?.bind(iterator),
				};
			},
			async result() {
				try {
					const message = await interceptExecution(operation, execution, () => stream.result());
					finish(message);
					return message;
				} catch (error) {
					finish(undefined, error);
					throw error;
				}
			},
		} as ReturnType<Models['streamSimple']>;
	}

	#decoration(turn: TurnContext): EventScope {
		return {
			...(turn.conversationId === ROOT ? { session: 'default', harness: 'default' } : {}),
			...(turn.conversationId > 0 ? { conversationId: `pi:${turn.conversationId}` } : {}),
			...(turn.submissionId !== undefined ? { submissionId: turn.submissionId } : {}),
		};
	}

	// ─── Generation hooks ────────────────────────────────────────────────────

	/** Names each request's turn; register after every hook that rewrites the request. */
	generationHooks(): Partial<GenerationHooks> {
		return {
			beforeRequest: (_request, api: HookApi) => {
				const signal = (api as HookApi & { signal?: AbortSignal }).signal;
				if (!signal) return undefined;
				const count = (this.#turnCounts.get(api.taskId) ?? 0) + 1;
				this.#turnCounts.set(api.taskId, count);
				const live = this.#live.get(api.conversationId);
				const first = live?.run?.inputs[0];
				const submissionId = first !== undefined ? this.#flueIds.get(first) : undefined;
				this.#turns.set(signal, {
					turnId: `turn_${api.taskId}${count > 1 ? `.${count}` : ''}`,
					conversationId: api.conversationId,
					...(submissionId !== undefined ? { submissionId } : {}),
				});
				return undefined;
			},
		};
	}

	// ─── Commits ─────────────────────────────────────────────────────────────

	/** Start deriving events from `harness`'s commits; returns the unsubscribe. */
	attach(harness: Harness): () => void {
		return harness.subscribeCommits((publication) => {
			try {
				this.#observe(publication);
			} catch {
				// Telemetry never breaks the Session line.
			}
		});
	}

	#observe(publication: CommitPublication): void {
		const at = this.#now();
		const lives: { conversationId: number; before: LiveValue; after: LiveValue }[] = [];
		const settledInputs: { id: number; status: string; reason?: string }[] = [];
		const placedInputs: number[] = [];
		const toolResults = new Map<string, { isError: boolean; result: unknown }>();
		for (const change of publication.changes) {
			if (change.type === 'document') {
				if (change.record.kind === 'pi.live' && change.conversationId !== undefined) {
					const before = this.#live.get(change.conversationId) ?? {};
					const after = (change.value ?? {}) as LiveValue;
					this.#live.set(change.conversationId, after);
					lives.push({ conversationId: change.conversationId, before, after });
				} else if (
					change.record.kind === 'flue.receipts' &&
					change.record.key !== undefined &&
					change.value
				) {
					this.#receipts.set(change.record.key, change.value as ReceiptValue);
				}
			} else if (change.type === 'entry') {
				const message = change.value.model?.[0];
				if (message?.role === 'user') {
					const text =
						typeof message.content === 'string'
							? message.content
							: message.content
									.flatMap((part) => (part.type === 'text' ? [part.text] : []))
									.join('');
					this.#inputs.set(change.value.conversationId, text);
				}
				if (message?.role === 'assistant') {
					this.#answers.set(change.value.conversationId, {
						text: message.content
							.flatMap((part) => (part.type === 'text' ? [part.text] : []))
							.join(''),
						finishReason: message.stopReason,
					});
					for (const block of message.content) {
						if (block.type === 'toolCall')
							this.#toolArgs.set(block.id, block.arguments as JsonValue);
					}
				} else if (message?.role === 'toolResult') {
					const details = message.details as { output?: unknown } | undefined;
					toolResults.set(message.toolCallId, {
						isError: message.isError,
						result: details && 'output' in details ? details.output : message.content,
					});
				}
			} else if (change.type === 'submission') {
				const record = change.value;
				if (record.type === 'input' && record.status === 'unanswered')
					this.#failedInputs.add(record.id);
				if (record.type !== 'input' || record.conversationId !== ROOT) continue;
				if (record.requestId !== undefined) this.#flueIds.set(record.id, record.requestId);
				if (record.status === 'placed') placedInputs.push(record.id);
				if (record.status === 'done' || record.status === 'unanswered') {
					settledInputs.push({
						id: record.id,
						status: record.status,
						...(record.reason ? { reason: record.reason } : {}),
					});
				}
			}
		}
		for (const { conversationId, before, after } of lives) {
			this.#tools(conversationId, before, after, toolResults, at);
			this.#compaction(conversationId, before, after, at);
			this.#run(conversationId, before, after, at);
		}
		for (const id of placedInputs) this.#submissionRunning(id);
		for (const input of settledInputs) this.#submissionSettled(input);
	}

	#scope(conversationId: number): EventScope {
		const live = this.#live.get(conversationId);
		const first = live?.run?.inputs[0];
		const submissionId = first !== undefined ? this.#flueIds.get(first) : undefined;
		return {
			...(conversationId === ROOT ? { session: 'default', harness: 'default' } : {}),
			conversationId: `pi:${conversationId}`,
			...(submissionId !== undefined ? { submissionId } : {}),
		};
	}

	#tools(
		conversationId: number,
		before: LiveValue,
		after: LiveValue,
		results: Map<string, { isError: boolean; result: unknown }>,
		at: number,
	): void {
		const previous = new Map((before.tools ?? []).map((slot) => [slot.callId, slot]));
		for (const slot of after.tools ?? []) {
			const was = previous.get(slot.callId);
			if (slot.status === 'running' && was?.status !== 'running') {
				const args = this.#toolArgs.get(slot.callId);
				this.#toolStarts.set(slot.callId, { at, args });
				this.#options.emit({
					type: 'tool_start',
					toolName: slot.name,
					toolCallId: slot.callId,
					...(args !== undefined ? { args } : {}),
					...this.#scope(conversationId),
				});
			}
			if (slot.status === 'done' && was?.status !== 'done')
				this.#toolEnd(conversationId, slot, results, at);
		}
		for (const slot of before.tools ?? []) {
			if (
				slot.status !== 'done' &&
				!(after.tools ?? []).some((each) => each.callId === slot.callId)
			) {
				this.#toolEnd(conversationId, slot, results, at);
			}
		}
	}

	#toolEnd(
		conversationId: number,
		slot: { callId: string; name: string },
		results: Map<string, { isError: boolean; result: unknown }>,
		at: number,
	): void {
		const started = this.#toolStarts.get(slot.callId);
		if (!started) return;
		this.#toolStarts.delete(slot.callId);
		this.#toolArgs.delete(slot.callId);
		const result = results.get(slot.callId);
		this.#options.emit({
			type: 'tool',
			toolName: slot.name,
			toolCallId: slot.callId,
			isError: result?.isError ?? true,
			...(result ? { result: result.result } : {}),
			durationMs: at - started.at,
			...this.#scope(conversationId),
		});
	}

	#compaction(conversationId: number, before: LiveValue, after: LiveValue, at: number): void {
		const was = new Set((before.compactions ?? []).map((status) => status.taskId));
		const now = new Set((after.compactions ?? []).map((status) => status.taskId));
		for (const status of after.compactions ?? []) {
			if (was.has(status.taskId)) continue;
			this.#compactions.set(status.taskId, at);
			this.#options.emit({
				type: 'compaction_start',
				reason: status.reason,
				estimatedTokens: 0,
				...this.#scope(conversationId),
			});
		}
		for (const status of before.compactions ?? []) {
			if (now.has(status.taskId)) continue;
			const startedAt = this.#compactions.get(status.taskId) ?? at;
			this.#compactions.delete(status.taskId);
			this.#options.emit({
				type: 'compaction',
				messagesBefore: 0,
				messagesAfter: 0,
				durationMs: at - startedAt,
				isError: false,
				...this.#scope(conversationId),
			});
		}
	}

	#run(conversationId: number, before: LiveValue, after: LiveValue, at: number): void {
		const was = before.run?.inputs[0];
		const now = after.run?.inputs[0];
		if (was === now) return;
		if (was !== undefined) {
			const operationId = `op_${conversationId}_${was}`;
			const startedAt = this.#runs.get(operationId) ?? at;
			this.#runs.delete(operationId);
			const answer = this.#answers.get(conversationId);
			const failed = (before.run?.inputs ?? []).some((input) => this.#failedInputs.has(input));
			this.#options.emit(
				{
					type: 'operation',
					operationId,
					operationKind: 'prompt',
					durationMs: at - startedAt,
					isError: failed,
					...this.#scope(conversationId),
					...(this.#flueIds.get(was) !== undefined ? { submissionId: this.#flueIds.get(was) } : {}),
				},
				answer && !failed ? { agentOutput: { type: 'text', ...answer } } : undefined,
			);
		}
		if (now !== undefined) {
			const operationId = `op_${conversationId}_${now}`;
			this.#runs.set(operationId, at);
			const input = this.#inputs.get(conversationId);
			this.#options.emit(
				{
					type: 'operation_start',
					operationId,
					operationKind: 'prompt',
					...this.#scope(conversationId),
					...(this.#flueIds.get(now) !== undefined ? { submissionId: this.#flueIds.get(now) } : {}),
				},
				input !== undefined ? { agentInput: { text: input } } : undefined,
			);
		}
	}

	#submissionRunning(id: number): void {
		const submissionId = this.#flueIds.get(id);
		if (submissionId === undefined) return;
		const receipt = this.#receipts.get(submissionId);
		this.#options.emit({
			type: 'submission_running',
			submissionId,
			kind: receipt?.kind ?? 'dispatch',
			attemptCount: receipt?.attempts ?? 1,
			maxAttempts: receipt?.maxAttempts ?? 0,
		});
	}

	#submissionSettled(input: { id: number; status: string; reason?: string }): void {
		const submissionId = this.#flueIds.get(input.id);
		if (submissionId === undefined) return;
		const receipt = this.#receipts.get(submissionId);
		const outcome =
			receipt?.classification !== undefined
				? 'failed'
				: input.status === 'done'
					? 'completed'
					: input.reason === 'aborted'
						? 'aborted'
						: 'failed';
		this.#options.emit({
			type: 'submission_settled',
			submissionId,
			outcome,
			...(outcome === 'completed'
				? {}
				: {
						error: serializeSubmissionError(
							new Error(input.reason ?? receipt?.classification ?? 'failed'),
						),
					}),
		});
	}

	/** Report that admission queued a submission. */
	queued(submissionId: string, kind: 'dispatch' | 'direct'): void {
		this.#options.emit({ type: 'submission_queued', submissionId, kind });
	}

	/** Context of a turn, for code that runs between hooks and provider calls. */
	turnOf(signal: AbortSignal | undefined): TurnContext | undefined {
		return signal ? this.#turns.get(signal) : undefined;
	}
}

/** Emit helper for callers that only hold a context. */
export function contextEmitter(context: Context | undefined): Context | undefined {
	return context;
}
