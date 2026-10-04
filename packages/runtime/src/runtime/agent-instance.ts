/**
 * One agent instance on Pi Durable (docs/cloudflare-native.md): the
 * platform-neutral core both coordinators drive. It owns the instance's
 * database — Durable Object SQLite on Cloudflare, `node:sqlite` on Node —
 * holding Pi's own `SqliteStorage` (the instance's record) and Flue's tables
 * beside it: the conversation cache the public wire is served from
 * (`pi/conversation-cache.ts`) and the entity wake book
 * (`entity/wake-book.ts`). It renders the agent function onto its
 * `FluePiHost`, admits deliveries, pumps entity events and wakes Pi.
 *
 * Open sequence: `SqliteStorage.open` → `createFluePiHost` → `host.open`
 * (the cache attaches to Pi's commits) → the one-time legacy import → render
 * (`renderedAgentFrom`) → `host.applyRender`. Re-renders run at admission (the delivery cursor
 * moved) and at every tool-round boundary (`afterTools`), so state written
 * by tools reaches the next request. Pi owns everything else: the loop,
 * compaction, retries, recovery, the inbox, ownership and abort cascades.
 */
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	GenerationTask,
	hook,
	ROOT_CONVERSATION_ID,
	type TaskInspection,
	type ToolRegistration,
	type Tx,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type SqliteDatabase, SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import type { CountingSqliteDatabase } from '../cloudflare/do-sqlite-database.ts';
import { decodeBase64, encodeBase64 } from '../base64.ts';
import type { FlueContextInternal } from '../client.ts';
import { discoverWorkspace } from '../context.ts';
import type { FlueExecutionContext } from '../execution-interceptor.ts';
import { interceptExecution } from '../execution-interceptor.ts';
import { createLifecycleHarness, createToolHarness } from '../harness.ts';
import type { RenderStateContext } from '../hooks/frame.ts';
import { renderAgentFunctionWithStructure } from '../hooks/render.ts';
import type { EntitySubscriptionPort } from '../entity/facet.ts';
import { createEntityRuntime, type EntityRuntime } from '../entity/runtime.ts';
import { type PumpLimits, type PumpResult, pumpEntity } from '../entity/pump.ts';
import { EntityWakeBook } from '../entity/wake-book.ts';
import { importLegacyConversation } from '../legacy/import.ts';
import type { McpConnectionDefinition, McpConnectionResolver } from '../mcp.ts';
import { appendCreating } from '../entity/append.ts';
import { eventsPath } from '../entity/paths.ts';
import { projectSettlementToElectricEvent } from '../mcp-server/events.ts';
import type { AgentOperationService } from '../mcp-server/ports.ts';
import type { CapabilityResult, McpInputRequest, Operation } from '../mcp-server/types.ts';
import { createAgentOutputChannel } from '../message-output.ts';
import {
	FlueInstance,
	FlueReceiptIndex,
	FlueReceipts,
	type FlueReceiptState,
	FlueState,
} from '../pi/docs.ts';
import {
	listPendingQuestions,
	onlyParked,
	type PendingQuestion,
	parkedQuestionTasks,
	readQuestion,
} from '../pi/questions.ts';
import { appendAnswer } from '../entity/questions.ts';
import type { EntityRef } from '../entity/services.ts';
import type { FlueAnswer } from '../questions.ts';
import { executionEnvFromSandbox } from '../pi/execution-env.ts';
import type { FlueAttachmentPort } from '../pi/hooks.ts';
import {
	createFluePiHost,
	type FluePiHost,
	type FlueSettlement,
	type WakeReason,
} from '../pi/host.ts';
import { renderedAgentFrom } from '../pi/registry-bridge.ts';
import { hasPiState, PiConversationCache } from '../pi/conversation-cache.ts';
import { PiTelemetry } from '../pi/telemetry.ts';
import { agentToolRegistration, type FlueToolDeps, flueToolRegistration } from '../pi/tools.ts';
import { createCwdSandbox } from '../sandbox.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import type {
	Agent,
	AgentRuntimeConfig,
	DeliveredMessage,
	DispatchReceipt,
	FlueEventInput,
	FlueLogger,
	FlueObservationDetail,
	RegisteredSkill,
	Sandbox,
	SandboxFactory,
} from '../types.ts';
import { parseCreationData, submissionLimits } from './agent-submissions.ts';
import { deriveKeyedSubmissionId, generateSubmissionId } from './ids.ts';
import { type AttachmentStore, createAttachmentRef } from './attachment-store.ts';
import type { ConversationProjectionSource } from './conversation-source.ts';
import type { ConversationStreamStore } from './conversation-stream-store.ts';
import { ATTACHMENT_CONVERSATION_SCOPE } from './handle-conversation-routes.ts';
import { getRuntimeModels, resolveModel } from './providers.ts';
import { agentStreamPath } from './stream-offsets.ts';

export interface FlueAgentInstanceOptions {
	readonly agentName: string;
	readonly instanceId: string;
	readonly agent: Agent;
	/** The instance's database: DO SQLite on Cloudflare, `node:sqlite` on Node. Opened once. */
	readonly database: () => CountingSqliteDatabase | Promise<CountingSqliteDatabase>;
	readonly attachments: AttachmentStore;
	/** The pre-upgrade record store holding this instance's legacy stream, if any. */
	readonly legacy?: ConversationStreamStore;
	/** Arm a wake: the DO alarm on Cloudflare, a timer on Node. */
	readonly armWake: (atMs: number, reason: WakeReason) => void | Promise<void>;
	/** The instance's event context (`observe()`, telemetry, logs). */
	readonly events: FlueContextInternal;
	readonly mcp: McpConnectionResolver;
	/**
	 * A2A entities (`entity/*`): send/publish/observe/spawn/schedule tools and
	 * the inbox, over `log` — the entity streams every instance reaches (an
	 * Electric server, or one Node process's own store).
	 */
	readonly entities?:
		| {
				readonly log: DurableStreamLog;
				readonly subscriptions?: EntitySubscriptionPort;
				/** Pump chunk limits (`entity/pump.ts`); the defaults are designed for Cloudflare. */
				readonly pump?: PumpLimits;
		  }
		| false;
	readonly now?: () => number;
	readonly onReport?: (error: unknown) => void;
}

/** One admission handed to the instance by a coordinator. */
export interface FlueInstanceAdmission {
	readonly kind: 'dispatch' | 'direct';
	readonly submissionId: string;
	readonly message: DeliveredMessage;
	readonly initialData?: unknown;
	readonly uid?: string | null;
	readonly acceptedAt: string;
	readonly traceCarrier?: { traceparent: string; tracestate?: string };
}

const NO_SANDBOX =
	'[flue] This agent has no sandbox. Declare one with useSandbox() to use shell and filesystem operations.';

function isSandboxFactory(value: unknown): value is SandboxFactory {
	return (
		typeof value === 'object' &&
		value !== null &&
		(typeof (value as SandboxFactory).createSandbox === 'function' ||
			typeof (value as { createSessionEnv?: unknown }).createSessionEnv === 'function')
	);
}

interface Opened {
	readonly database: CountingSqliteDatabase;
	readonly host: FluePiHost;
	readonly telemetry: PiTelemetry;
	readonly entity: EntityRuntime | undefined;
	readonly detach: () => void;
}

/** Pending hook writes: `usePersistentState` values and `useDataWriter` parts. */
interface PendingWrites {
	state: Map<string, unknown>;
	data: { name: string; data: unknown }[];
}

export class FlueAgentInstance implements AgentOperationService {
	readonly agentName: string;
	readonly instanceId: string;
	/** The public conversation, served from the cache over Pi storage. */
	readonly source: ConversationProjectionSource;
	/** Names the conversation in HEAD errors (the pre-upgrade stream path). */
	readonly logPath: string;
	readonly #options: FlueAgentInstanceOptions;
	readonly #now: () => number;
	#database: Promise<CountingSqliteDatabase> | undefined;
	#cache: PiConversationCache | undefined;
	#book: EntityWakeBook | undefined;
	#opened: Promise<Opened> | undefined;
	#closed = false;
	/** The latest delivered message: what `useDelivery()` reads. */
	#delivery: DeliveredMessage | undefined;
	#pending: PendingWrites = { state: new Map(), data: [] };
	/** State values as of the last render, overlaid by pending writes. */
	#stateSnapshot = new Map<string, unknown>();
	#renderChain: Promise<unknown> = Promise.resolve();
	#publishedSettlements = new Set<string>();
	#publishingSettlements = new Map<string, Promise<void>>();
	/** The resolved sandbox and the factory/cwd it came from. */
	#sandbox: {
		factory: SandboxFactory | undefined;
		cwd: string | undefined;
		current: Sandbox | undefined;
		/** `SandboxFactory.tools` over `current`, built once per sandbox. */
		tools?: readonly ToolRegistration[];
	} = { factory: undefined, cwd: undefined, current: undefined };
	#workspace:
		{ sandbox: Sandbox | undefined; context: string; skills: RegisteredSkill[] } | undefined;
	readonly #sandboxProxy: Sandbox;
	#toolDeps: FlueToolDeps | undefined;
	readonly #envProxy: ExecutionEnv;
	readonly #envs = new WeakMap<Sandbox, ExecutionEnv>();

	constructor(options: FlueAgentInstanceOptions) {
		this.#options = options;
		this.agentName = options.agentName;
		this.instanceId = options.instanceId;
		this.#now = options.now ?? Date.now;
		this.logPath = agentStreamPath(options.agentName, options.instanceId);
		const cache = () => this.#conversationCache();
		this.source = {
			meta: async (signal) => (await cache()).meta(signal),
			head: async (signal) => (await cache()).head(signal),
			read: async (from, readOptions) => (await cache()).read(from, readOptions),
		};
		const current = (): Sandbox => {
			const sandbox = this.#sandbox.current;
			if (!sandbox) throw new Error(NO_SANDBOX);
			return sandbox;
		};
		this.#sandboxProxy = new Proxy({} as Sandbox, {
			get(_target, property) {
				const sandbox = current();
				const value = Reflect.get(sandbox, property, sandbox);
				return typeof value === 'function' ? value.bind(sandbox) : value;
			},
		});
		const envOf = (): ExecutionEnv => {
			const sandbox = current();
			let env = this.#envs.get(sandbox);
			if (!env) {
				env = executionEnvFromSandbox(sandbox, sandbox.cwd);
				this.#envs.set(sandbox, env);
			}
			return env;
		};
		this.#envProxy = new Proxy({} as ExecutionEnv, {
			get(_target, property) {
				const env = envOf();
				const value = Reflect.get(env, property, env);
				return typeof value === 'function' ? value.bind(env) : value;
			},
		});
	}

	/** The sandbox proxy; throws, like `harness.sandbox` always did, when the agent declared none. */
	#liveSandbox(): Sandbox {
		if (!this.#sandbox.current) throw new Error(NO_SANDBOX);
		return this.#sandboxProxy;
	}

	// ─── Events ─────────────────────────────────────────────────────────────

	async #publishSettlementEvent(settlement: {
		submissionId: string;
		outcome: 'completed' | 'failed' | 'aborted';
		error?: unknown;
		result?: unknown;
		summary?: string;
		correlationId?: string;
		artifactRefs?: string[];
	}): Promise<void> {
		if (!this.#options.entities || typeof this.#options.entities === 'boolean') return;
		const entities = this.#options.entities;

		if (this.#publishedSettlements.has(settlement.submissionId)) {
			return;
		}

		const inFlight = this.#publishingSettlements.get(settlement.submissionId);
		if (inFlight) {
			await inFlight;
			return;
		}

		const publishPromise = (async () => {
			const book = await this.#wakeBook();
			if (book.isSettlementPublished(settlement.submissionId)) {
				this.#publishedSettlements.add(settlement.submissionId);
				return;
			}

			const self = { type: this.agentName, id: this.instanceId };
			const path = eventsPath(self);
			const domainEvent = projectSettlementToElectricEvent(settlement);
			try {
				await appendCreating(entities.log, path, domainEvent, undefined);
			} catch (err) {
				this.#report(err);
				return;
			}

			book.markSettlementPublished(settlement.submissionId);
			this.#publishedSettlements.add(settlement.submissionId);
		})();

		this.#publishingSettlements.set(settlement.submissionId, publishPromise);
		try {
			await publishPromise;
		} finally {
			this.#publishingSettlements.delete(settlement.submissionId);
		}
	}

	async #retryUnprojectedSettlements(host: FluePiHost, reason: WakeReason): Promise<void> {
		if (reason.kind !== 'live-tasks') return;
		if (!this.#options.entities || typeof this.#options.entities === 'boolean') return;

		const index = await host.harness.snapshot(FlueReceiptIndex, BACKGROUND_CONTEXT);
		if (!index?.live) return;

		const candidatesToQuery: string[] = [];
		for (const id of Object.keys(index.live)) {
			if (!this.#publishedSettlements.has(id)) {
				candidatesToQuery.push(id);
			}
		}

		if (candidatesToQuery.length === 0) return;

		const book = await this.#wakeBook();
		const { unprojected, published } = book.checkSettlementProjections(candidatesToQuery);
		for (const id of published) {
			this.#publishedSettlements.add(id);
		}

		for (const id of unprojected) {
			const settlement = await host.settlement(id, BACKGROUND_CONTEXT);
			if (settlement) {
				await this.#publishSettlementEvent({
					submissionId: settlement.submissionId,
					outcome: settlement.outcome,
					result: settlement.result,
					error: settlement.error,
				});
			}
		}
	}

	#emit(event: FlueEventInput, observation?: FlueObservationDetail): void {
		try {
			this.#options.events.emitEvent(event, observation);
		} catch {
			// Event delivery never breaks agent work.
		}

		if (event.type === 'submission_settled') {
			void this.#publishSettlementEvent({
				submissionId: event.submissionId,
				outcome: event.outcome,
				error: event.error,
			}).catch((err) => this.#report(err));
		}
	}

	#executionContext(fields: Partial<FlueExecutionContext> = {}): FlueExecutionContext {
		return {
			eventContext: this.#options.events,
			instanceId: this.instanceId,
			agentName: this.agentName,
			...fields,
		};
	}

	#report(error: unknown): void {
		this.#options.onReport?.(error);
		if (!this.#options.onReport) console.error('[flue:pi]', error);
	}

	#logger(attributes: Record<string, unknown>): FlueLogger {
		const log =
			(level: 'info' | 'warn' | 'error') => (message: string, extra?: Record<string, unknown>) =>
				this.#emit({ type: 'log', level, message, attributes: { ...attributes, ...extra } });
		return { info: log('info'), warn: log('warn'), error: log('error') };
	}

	// ─── Opening ────────────────────────────────────────────────────────────

	/** The instance's database, opened once. */
	#db(): Promise<CountingSqliteDatabase> {
		this.#database ??= Promise.resolve(this.#options.database());
		return this.#database;
	}

	async #conversationCache(): Promise<PiConversationCache> {
		if (this.#cache) return this.#cache;
		const database = await this.#db();
		this.#cache ??= new PiConversationCache({
			database,
			open: async () => {
				await this.#open();
			},
			now: this.#now,
			onReport: (error) => this.#report(error),
		});
		return this.#cache;
	}

	async #wakeBook(): Promise<EntityWakeBook> {
		this.#book ??= new EntityWakeBook(await this.#db());
		return this.#book;
	}

	/** The open host; opens storage, the Harness, and renders on first use. */
	async host(): Promise<FluePiHost> {
		return (await this.#open()).host;
	}

	#open(): Promise<Opened> {
		if (this.#closed) return Promise.reject(new Error('[flue] The agent instance is closed.'));
		this.#opened ??= this.#openNow();
		const pending = this.#opened;
		pending.catch(() => {
			if (this.#opened === pending) this.#opened = undefined;
		});
		return pending;
	}

	async #openNow(): Promise<Opened> {
		const context = BACKGROUND_CONTEXT;
		const options = this.#options;
		const database = await this.#db();
		const cache = await this.#conversationCache();
		const storage = await SqliteStorage.open(database);
		const telemetry = new PiTelemetry({
			emit: (event, observation) => this.#emit(event, observation),
			executionContext: (fields) => this.#executionContext(fields),
			resolveModel: (provider, modelId) => {
				try {
					return resolveModel(`${provider}/${modelId}`) as never;
				} catch {
					return undefined;
				}
			},
			now: this.#now,
		});
		// `host` is created below; these ports run only once it is open.
		const toolDeps: FlueToolDeps = {
			harness: async (call, callContext) =>
				createToolHarness({
					host,
					api: call.api,
					sandbox: () => this.#liveSandbox(),
					emit: (event, observation) => this.#emit(event, observation),
					executionContext: (fields) => this.#executionContext(fields),
					context: callContext,
				}),
			logger: (tool, callId) => this.#logger({ tool, toolCallId: callId }),
			around: async (call, run, callContext) => {
				try {
					return await interceptExecution(
						{ type: 'tool', toolCallId: call.api.callId, toolName: call.tool },
						this.#executionContext(),
						run,
					);
				} finally {
					await this.#flushWrites((change) => call.api.commit(change, callContext)).catch(
						(error) => {
							// An aborted call's writes never land; that is not a failure to report.
							if (!callContext.abortSignal?.aborted) this.#report(error);
						},
					);
				}
			},
		};
		this.#toolDeps = toolDeps;
		const host = createFluePiHost({
			entity: { type: this.agentName, id: this.instanceId },
			models: telemetry.models(getRuntimeModels()),
			storage: async () => storage,
			onOpened: (harness, opened, openContext) => cache.attach(harness, opened, openContext),
			sandbox: this.#sandboxProxy,
			env: () => (this.#sandbox.current ? this.#envProxy : undefined),
			now: this.#now,
			onReport: (error) => this.#report(error),
			armWake: async (atMs, reason) => {
				await options.armWake(atMs, reason);
			},
			parseInitialData: (data) => parseCreationData(options.agent, data),
			tools: toolDeps,
			mcp: (connections) => this.#resolveMcp(connections, toolDeps),
			attachments: this.#attachmentPort(),
			lifecycleHarness: (_conversationId, hookContext) =>
				createLifecycleHarness({
					host,
					sandbox: () => this.#liveSandbox(),
					emit: (event, observation) => this.#emit(event, observation),
					executionContext: (fields) => this.#executionContext(fields),
					context: hookContext,
				}),
			logger: (source) => this.#logger({ hook: source }),
		});
		host.registry.install({
			name: 'flue.render',
			hooks: [
				hook(GenerationTask, {
					// The turn boundary: re-render so state written by the round's tools
					// reaches the next request; flush what lifecycle callbacks wrote.
					// What `useAgentStart` callbacks wrote lands before the request, so a
					// tool aborted in this round cannot take it down with its own writes.
					beforeRequest: async () => {
						await this.#flushWrites((change) => host.harness.commit(change, context));
						return undefined;
					},
					afterTools: async () => {
						await this.#flushWrites((change) => host.harness.commit(change, context));
						await this.#render(host, undefined, context);
					},
					onYield: async () => {
						await this.#flushWrites((change) => host.harness.commit(change, context));
						return undefined;
					},
				}),
			],
		});
		host.registry.install({
			name: 'flue.telemetry',
			hooks: [hook(GenerationTask, telemetry.generationHooks())],
		});
		// The entity tools register before the first render picks active tools.
		// The entity runtime admits on its own (inbox messages, spawns, fired
		// schedules), so its host renders first, exactly as `admit()` does: an
		// entity woken for the first time has never rendered, and Pi would run
		// its turn with no model configured.
		const entity = options.entities
			? await createEntityRuntime({
					host: this.#renderingBeforeAdmission(host),
					entity: { type: this.agentName, id: this.instanceId },
					log: options.entities.log,
					armWake: async (atMs, reason) => {
						await options.armWake(atMs, reason);
					},
					...(options.entities.subscriptions
						? { subscriptions: options.entities.subscriptions }
						: {}),
					now: this.#now,
					onReport: (error) => this.#report(error),
				})
			: undefined;
		await host.open(context);
		const detach = telemetry.attach(host.harness);
		if (options.legacy) {
			await importLegacyConversation({
				harness: host.harness,
				store: options.legacy,
				path: agentStreamPath(this.agentName, this.instanceId),
				context,
			}).catch((error) => this.#report(error));
		}
		const instance = await host.harness.snapshot(FlueInstance, context);
		if (instance?.uid)
			await this.#render(host, undefined, context).catch((error) => this.#report(error));
		await entity?.refreshCursors(context).catch((error) => this.#report(error));
		return { database, host, telemetry, entity, detach };
	}

	// ─── Rendering ──────────────────────────────────────────────────────────

	/** `host`, whose `admit` first renders with the admitted message as the delivery cursor. */
	#renderingBeforeAdmission(host: FluePiHost): FluePiHost {
		const instance = this;
		return new Proxy(host, {
			get(target, property) {
				if (property === 'admit') {
					const admit: FluePiHost['admit'] = async (input, context) => {
						await instance.#renderForAdmission(target, input);
						return target.admit(input, context);
					};
					return admit;
				}
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	/** What `admit()` does before `host.admit`: the delivery cursor, and creation data for a birth. */
	async #renderForAdmission(
		host: FluePiHost,
		input: {
			readonly message: DeliveredMessage;
			readonly initialData?: unknown;
			readonly uid?: string | null;
		},
	): Promise<void> {
		const context = BACKGROUND_CONTEXT;
		this.#delivery = input.message;
		const instance = await host.harness.snapshot(FlueInstance, context);
		let override: { value: unknown } | undefined;
		if (!instance?.uid && typeof input.uid !== 'string') {
			override = { value: parseCreationData(this.#options.agent, input.initialData) };
		}
		await this.#render(host, override, context).catch((error) => this.#report(error));
	}

	/**
	 * Render the agent function and publish it to the host. Serialized;
	 * `initialData` overrides the birth record's for a creating admission.
	 */
	#render(
		host: FluePiHost,
		initialData: { value: unknown } | undefined,
		context: Context,
	): Promise<void> {
		const run = this.#renderChain.then(() => this.#renderNow(host, initialData, context));
		this.#renderChain = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	async #renderNow(
		host: FluePiHost,
		override: { value: unknown } | undefined,
		context: Context,
	): Promise<void> {
		const harness = host.harness;
		const instance = await harness.snapshot(FlueInstance, context);
		const stored = await harness.snapshot(FlueState, context);
		this.#stateSnapshot = new Map(Object.entries(stored?.values ?? {}));
		const output = createAgentOutputChannel();
		output.connect((name, data) => {
			this.#pending.data.push({ name, data });
		});
		const initialData =
			override ?? (instance?.initialData ? { value: instance.initialData.value } : undefined);
		const state: RenderStateContext = {
			snapshot: this.#stateSnapshot,
			store: {
				write: (name, value) => {
					const current = this.#currentState(name);
					if (current && JSON.stringify(current.value) === JSON.stringify(value)) return;
					this.#pending.state.set(name, value);
				},
				current: (name) => this.#currentState(name),
			},
			output,
			...(this.#delivery !== undefined ? { delivery: this.#delivery } : {}),
			instanceId: this.instanceId,
			agentName: this.agentName,
			...(initialData !== undefined ? { initialData: initialData.value } : {}),
		};
		const rendered = renderAgentFunctionWithStructure(this.#options.agent, state);
		await this.#syncSandbox(rendered.config);
		const workspace = await this.#discover();
		const render = renderedAgentFrom(rendered.config, output, {
			context: workspace.context,
			workspaceSkills: workspace.skills,
			...(rendered.codeMode ? { codeMode: rendered.codeMode } : {}),
			...(rendered.questions ? { questions: rendered.questions } : {}),
		});
		await host.applyRender(
			this.#sandbox.tools ? { ...render, sandboxTools: this.#sandbox.tools } : render,
			context,
		);
	}

	/** A sandbox factory's own tool, run like every Flue tool (tracing, hook-write flush). */
	#aroundTool(registration: ToolRegistration): ToolRegistration {
		return {
			...registration,
			execute: (args, api, context) => {
				const around = this.#toolDeps?.around;
				const run = () => registration.execute(args, api, context);
				return around ? around({ tool: registration.name, api }, run, context) : run();
			},
		};
	}

	#currentState(name: string): { value: unknown } | undefined {
		if (this.#pending.state.has(name)) return { value: this.#pending.state.get(name) };
		if (this.#stateSnapshot.has(name)) return { value: this.#stateSnapshot.get(name) };
		return undefined;
	}

	/** Resolve the render's sandbox; a presence change swaps it at this render (a turn boundary). */
	async #syncSandbox(config: AgentRuntimeConfig): Promise<void> {
		const factory = config.sandbox;
		if (factory === this.#sandbox.factory && config.cwd === this.#sandbox.cwd) return;
		if (factory === undefined) {
			this.#sandbox = { factory: undefined, cwd: undefined, current: undefined };
			return;
		}
		// The same factory object across renders keeps its live sandbox; only a
		// different declaration resolves a new one.
		if (factory === this.#sandbox.factory && this.#sandbox.current) {
			this.#sandbox = { ...this.#sandbox, cwd: config.cwd };
			return;
		}
		// A new declaration: forget the previous workspace discovery with it.
		this.#workspace = undefined;
		if (!isSandboxFactory(factory))
			throw new Error('[flue] Invalid sandbox option composed by the agent function.');
		const create =
			factory.createSandbox ??
			(factory as unknown as { createSessionEnv?: SandboxFactory['createSandbox'] })
				.createSessionEnv;
		if (!create) throw new Error('[flue] Invalid sandbox option composed by the agent function.');
		const base = await create.call(factory, { id: this.instanceId });
		const current = config.cwd ? createCwdSandbox(base, base.resolvePath(config.cwd)) : base;
		const tools = factory.tools?.(current, {
			subagents: Object.fromEntries(
				(config.subagents ?? []).map((subagent) => [subagent.name, subagent]),
			),
		});
		this.#sandbox = {
			factory,
			cwd: config.cwd,
			current,
			...(tools
				? { tools: tools.map((tool) => this.#aroundTool(agentToolRegistration(tool))) }
				: {}),
		};
	}

	async #discover(): Promise<{ context: string; skills: RegisteredSkill[] }> {
		const sandbox = this.#sandbox.current;
		if (this.#workspace && this.#workspace.sandbox === sandbox) return this.#workspace;
		const found = await discoverWorkspace(sandbox);
		this.#workspace = { sandbox, context: found.context, skills: found.skills };
		return this.#workspace;
	}

	/** Commit what hooks wrote since the last flush: state values and data parts. */
	async #flushWrites(commit: (change: (tx: Tx) => Promise<void>) => Promise<void>): Promise<void> {
		const pending = this.#pending;
		if (pending.state.size === 0 && pending.data.length === 0) return;
		this.#pending = { state: new Map(), data: [] };
		await commit(async (tx) => {
			if (pending.state.size > 0) {
				const doc = await tx.doc(FlueState);
				for (const [name, value] of pending.state) doc.values[name] = value as never;
			}
			for (const part of pending.data) {
				await tx.appendEntry(ROOT_CONVERSATION_ID, {
					kind: 'flue.data',
					data: { name: part.name, data: (part.data ?? null) as never },
				});
			}
		});
		for (const [name, value] of pending.state) this.#stateSnapshot.set(name, value);
	}

	async #resolveMcp(
		connections: readonly McpConnectionDefinition[],
		toolDeps: FlueToolDeps,
	): Promise<readonly ToolRegistration[]> {
		const settled = await Promise.allSettled(
			connections.map((definition) => this.#options.mcp.resolve(definition)),
		);
		const tools: ToolRegistration[] = [];
		for (const [index, result] of settled.entries()) {
			const declared = connections[index] as McpConnectionDefinition;
			if (result.status === 'fulfilled') {
				for (const tool of result.value.tools) tools.push(flueToolRegistration(tool, toolDeps));
			} else if (declared.optional) {
				this.#emit({
					type: 'log',
					level: 'warn',
					message: `MCP server "${declared.name}" is unavailable; its tools are not mounted.`,
					attributes: {
						server: declared.name,
						reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
					},
				});
			} else {
				throw result.reason;
			}
		}
		return tools;
	}

	#attachmentPort(): FlueAttachmentPort {
		const streamPath = agentStreamPath(this.agentName, this.instanceId);
		const store = this.#options.attachments;
		return {
			async put(submissionId, index, attachment) {
				const id = `att_${submissionId}_${index}`;
				const bytes = decodeBase64(attachment.data);
				const ref = await createAttachmentRef({
					id,
					mimeType: attachment.mimeType,
					bytes,
					...(attachment.filename ? { filename: attachment.filename } : {}),
				});
				await store.put({
					streamPath,
					attachment: ref,
					bytes,
					conversationId: ATTACHMENT_CONVERSATION_SCOPE,
				});
				return id;
			},
			async get(id) {
				const stored = await store.get({
					streamPath,
					conversationId: ATTACHMENT_CONVERSATION_SCOPE,
					attachmentId: id,
				});
				return stored
					? { data: encodeBase64(stored.bytes), mimeType: stored.attachment.mimeType }
					: undefined;
			},
		};
	}

	// ─── Coordinator verbs ──────────────────────────────────────────────────

	/**
	 * Admit one delivery: render with it as the delivery cursor (and, for a
	 * creating send, its creation data), then the two-commit Pi admission.
	 * Returns the receipt and the conversation offset to follow it from.
	 */
	async admit(input: FlueInstanceAdmission): Promise<{ receipt: DispatchReceipt; offset: string }> {
		const { host, telemetry } = await this.#open();
		const context = BACKGROUND_CONTEXT;
		const offset = (await this.source.meta())?.nextOffset ?? '-1';
		this.#delivery = input.message;
		const instance = await host.harness.snapshot(FlueInstance, context);
		let override: { value: unknown } | undefined;
		if (!instance?.uid && typeof input.uid !== 'string') {
			override = { value: parseCreationData(this.#options.agent, input.initialData) };
		}
		await this.#render(host, override, context).catch((error) => this.#report(error));
		const receipt = await host.admit(
			{
				submissionId: input.submissionId,
				kind: input.kind,
				message: input.message,
				...(input.initialData !== undefined ? { initialData: input.initialData } : {}),
				...(input.uid !== undefined ? { uid: input.uid } : {}),
				acceptedAt: input.acceptedAt,
				whenBusy: 'steer',
				limits: submissionLimits(this.agentName, input.acceptedAt),
				...(input.traceCarrier ? { traceCarrier: { ...input.traceCarrier } } : {}),
			},
			context,
		);
		telemetry.queued(input.submissionId, input.kind);
		await host.wake({ kind: 'dispatch' }, context);
		return { receipt, offset };
	}

	/**
	 * Ring the doorbell: `stream` holds events through `head`. Records the
	 * high-water mark in the wake book, then arms a wake now; the wake pumps.
	 * (The Cloudflare coordinator rings the book itself, synchronously with
	 * its wake job, without opening the instance.)
	 */
	async ring(stream: string, head: string): Promise<void> {
		(await this.#wakeBook()).ring(stream, head);
		await this.#options.armWake(this.#now(), { kind: 'pump' });
	}

	/**
	 * Wake (an alarm, a timer): pump entity events from their cursors in one
	 * bounded chunk, fire due schedules, then repair admissions, enforce
	 * limits and resume Pi. `behind` says the pump left events for the next
	 * wake; the caller re-arms while it is set.
	 */
	async wake(
		reason: WakeReason,
	): Promise<{ readonly behind: boolean; readonly pump?: PumpResult }> {
		const opened = await this.#open();
		const context = BACKGROUND_CONTEXT;
		let pump: PumpResult | undefined;
		if (opened.entity && this.#options.entities) {
			const book = await this.#wakeBook();
			if (book.behind()) {
				pump = await pumpEntity(opened.entity, book, context, {
					...(this.#options.entities.pump ? { limits: this.#options.entities.pump } : {}),
					now: this.#now,
				});
			}
			await opened.entity.wake(reason, context);
		} else {
			await opened.host.wake(reason, context);
		}
		await this.#retryUnprojectedSettlements(opened.host, reason).catch((error) =>
			this.#report(error),
		);
		return { behind: pump?.behind ?? false, ...(pump ? { pump } : {}) };
	}

	/** Abort every session's work. `true` when there was work to abort. */
	async abort(): Promise<boolean> {
		const { host } = await this.#open();
		const context = BACKGROUND_CONTEXT;
		const inspection = await host.harness.inspect(context);
		const busy =
			inspection.submissions.length > 0 || inspection.tasks.some((task) => !task.record.background);
		if (!busy) return false;
		// Conversation aborts resolve once the work is idle; the caller observes
		// the aborted settlement on the conversation instead of waiting here.
		void host.abort(undefined, context).catch((error) => this.#report(error));
		return true;
	}

	/** Existence and uid, without opening (or creating) anything for an unknown instance. */
	async info(): Promise<{ exists: boolean; uid?: string }> {
		if (!this.#opened && !hasPiState(await this.#db())) {
			if (
				!this.#options.legacy ||
				!(await this.#options.legacy.getMeta(agentStreamPath(this.agentName, this.instanceId)))
			) {
				return { exists: false };
			}
		}
		const { host } = await this.#open();
		const instance = await host.harness.snapshot(FlueInstance, BACKGROUND_CONTEXT);
		return instance?.uid ? { exists: true, uid: instance.uid } : { exists: false };
	}

	async settlement(submissionId: string): Promise<FlueSettlement | undefined> {
		const { host } = await this.#open();
		return host.settlement(submissionId, BACKGROUND_CONTEXT);
	}

	/**
	 * Whether Pi holds no live work and no entity event waits to be pumped.
	 * Work that only waits on parked questions counts as idle: nothing runs
	 * until an answer (or a deadline) wakes the instance.
	 */
	async idle(): Promise<boolean> {
		if (!this.#opened) return true;
		const { host } = await this.#open();
		const behind = this.#options.entities ? (await this.#wakeBook()).behind() : false;
		return !behind && (await this.#settledOrParked(host));
	}

	async #settledOrParked(host: FluePiHost): Promise<boolean> {
		const inspection = await host.harness.inspect(BACKGROUND_CONTEXT);
		if (inspection.tasks.length === 0) return inspection.submissions.length === 0;
		return onlyParked(
			inspection.tasks,
			await parkedQuestionTasks(host.harness, BACKGROUND_CONTEXT),
		);
	}

	/** Live work exists, and all of it waits on parked questions. */
	async #onlyParked(host: FluePiHost): Promise<boolean> {
		const inspection = await host.harness.inspect(BACKGROUND_CONTEXT);
		return (
			inspection.tasks.length > 0 &&
			onlyParked(inspection.tasks, await parkedQuestionTasks(host.harness, BACKGROUND_CONTEXT))
		);
	}

	/**
	 * Resolve when every conversation's ordinary work is idle, or waits only
	 * on parked questions (nothing more happens until an answer arrives).
	 */
	async waitForIdle(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		if (!this.#opened) return;
		const { host } = await this.#open();
		let settled = false;
		const idle = host.harness.waitForIdle(context).finally(() => {
			settled = true;
		});
		idle.catch(() => {});
		while (!settled) {
			if (await this.#onlyParked(host)) return;
			await Promise.race([idle, new Promise((resolve) => setTimeout(resolve, 25))]);
		}
		await idle;
	}

	// ─── Questions (rule 9) ─────────────────────────────────────────────────

	/** The questions this instance waits on, oldest first. */
	async pendingQuestions(): Promise<PendingQuestion[]> {
		if (!this.#opened && !hasPiState(await this.#db())) return [];
		const { host } = await this.#open();
		return listPendingQuestions(host.harness, BACKGROUND_CONTEXT);
	}

	/**
	 * Answer one of this instance's questions as a participant does: append
	 * an `input-answered` event to its inbox, then ring its doorbell. The
	 * pump admits the answer like any inbox event. An unknown or settled
	 * question, or an answer of the wrong kind, is refused here before
	 * anything is appended.
	 */
	async answerQuestion(
		questionId: string,
		answer: FlueAnswer,
		options: { readonly from?: EntityRef; readonly answerId?: string } = {},
	): Promise<
		| { readonly status: 'accepted'; readonly eventId: string }
		| { readonly status: 'unknown' }
		| { readonly status: 'settled'; readonly questionStatus: string }
		| { readonly status: 'mismatched'; readonly expected: string }
	> {
		const entities = this.#options.entities;
		if (!entities) {
			throw new Error(
				'[flue] Questions travel on entity streams; configure Electric (FLUE_STREAMS_URL) to answer them.',
			);
		}
		if (!this.#opened && !hasPiState(await this.#db())) return { status: 'unknown' };
		const { host } = await this.#open();
		const record = await readQuestion(host.harness, questionId, BACKGROUND_CONTEXT);
		if (!record) return { status: 'unknown' };
		if (record.status !== 'parked') return { status: 'settled', questionStatus: record.status };
		const expected = (record.question as { kind?: string } | null)?.kind ?? '';
		if (answer.kind !== expected) return { status: 'mismatched', expected };
		const self = { type: this.agentName, id: this.instanceId };
		const eventId = `answer:${options.answerId ?? crypto.randomUUID()}`;
		const { inbox } = await appendAnswer(entities.log, self, {
			from: options.from ?? { type: 'person', id: 'http' },
			questionId,
			answer,
			eventId,
		});
		const head = await entities.log.head(inbox);
		if (head) await this.ring(inbox, head.nextOffset);
		return { status: 'accepted', eventId };
	}

	/** Rows this instance's database read and wrote so far (the counting facades only). */
	async rows(): Promise<{ rowsRead: number; rowsWritten: number } | undefined> {
		const database = (await this.#db()) as SqliteDatabase & {
			rows?: { rowsRead: number; rowsWritten: number };
		};
		return database.rows ? { ...database.rows } : undefined;
	}

	// ─── AgentOperationService ──────────────────────────────────────────────

	async submitTask(params: {
		capabilityId: string;
		payload?: Record<string, unknown>;
		correlationId?: string;
	}): Promise<{ taskId: string; state: Operation['state'] }> {
		const submissionId = params.correlationId
			? await deriveKeyedSubmissionId(this.agentName, this.instanceId, params.correlationId)
			: generateSubmissionId();
		const message: DeliveredMessage = {
			kind: 'signal',
			type: 'mcp.capability',
			body: JSON.stringify(params.payload ?? {}),
			attributes: { capabilityId: params.capabilityId },
		};
		const acceptedAt = new Date(this.#now()).toISOString();
		await this.admit({
			kind: 'direct',
			submissionId,
			message,
			acceptedAt,
		});
		return { taskId: submissionId, state: 'running' };
	}

	async questionsForTask(taskId: string, receipt?: FlueReceiptState): Promise<PendingQuestion[]> {
		if (!this.#opened && !hasPiState(await this.#db())) {
			return [];
		}
		const { host } = await this.#open();
		const targetReceipt =
			receipt ?? (await host.harness.snapshot(FlueReceipts, taskId, BACKGROUND_CONTEXT));
		if (!targetReceipt || targetReceipt.status === 'absent') {
			return [];
		}

		const allQuestions = await this.pendingQuestions();
		if (allQuestions.length === 0) return [];

		const inspection = await host.harness.inspect(BACKGROUND_CONTEXT);
		const parentOf = new Map<number, number>();
		const taskOwnerMap = new Map<number, TaskInspection>();
		for (const t of inspection.tasks) {
			const tid = Number(t.record.id);
			taskOwnerMap.set(tid, t);
			if (t.record.owner !== undefined) {
				parentOf.set(tid, Number(t.record.owner));
			}
		}

		const filtered: PendingQuestion[] = [];
		for (const q of allQuestions) {
			if (q.conversationId !== null && q.conversationId !== targetReceipt.conversationId) {
				continue;
			}

			const record = await readQuestion(host.harness, q.id, BACKGROUND_CONTEXT);
			if (record) {
				if (
					record.conversationId !== null &&
					record.conversationId !== targetReceipt.conversationId
				) {
					continue;
				}

				if (targetReceipt.piSubmissionId !== undefined) {
					if (record.callTaskId === null || record.callTaskId === undefined) {
						continue;
					}
					let curr: number | undefined = record.callTaskId;
					let matchesSubmission = false;
					while (curr !== undefined) {
						const task = taskOwnerMap.get(curr);
						if (task) {
							const subId = (task.record as Record<string, unknown>).submissionId;
							if (typeof subId === 'number') {
								if (subId === targetReceipt.piSubmissionId) {
									matchesSubmission = true;
								}
								break;
							}
						}
						curr = parentOf.get(curr);
					}
					if (!matchesSubmission) continue;
				}
			}

			filtered.push(q);
		}

		return filtered;
	}

	async getTask(taskId: string): Promise<Operation | undefined> {
		const settlement = await this.settlement(taskId);
		if (settlement) {
			await this.#publishSettlementEvent({
				submissionId: settlement.submissionId,
				outcome: settlement.outcome,
				result: settlement.result,
				error: settlement.error,
			});

			const state: Operation['state'] =
				settlement.outcome === 'completed'
					? 'completed'
					: settlement.outcome === 'aborted'
						? 'cancelled'
						: 'failed';

			const result: CapabilityResult | undefined =
				settlement.outcome === 'completed'
					? typeof settlement.result === 'object' &&
						settlement.result !== null &&
						'resultType' in settlement.result
						? (settlement.result as CapabilityResult)
						: {
								resultType: 'complete',
								content: [
									{
										type: 'text',
										text:
											typeof settlement.result === 'string'
												? settlement.result
												: JSON.stringify(settlement.result ?? null),
									},
								],
								structuredContent:
									typeof settlement.result === 'object' && settlement.result !== null
										? (settlement.result as Record<string, unknown>)
										: undefined,
							}
					: undefined;

			const error =
				settlement.outcome === 'failed'
					? {
							code: 'TASK_FAILED',
							message: settlement.error?.message ?? 'Task failed',
							details: settlement.error?.detail,
						}
					: undefined;

			return {
				operationId: taskId,
				capabilityId: 'agent.run',
				state,
				revision: 2,
				summary: settlement.outcome === 'aborted' ? 'Operation was cancelled' : undefined,
				result,
				error,
				createdAt: settlement.settledAt,
				updatedAt: settlement.settledAt,
			};
		}

		if (!this.#opened && !hasPiState(await this.#db())) {
			return undefined;
		}

		const { host } = await this.#open();
		const receipt = await host.harness.snapshot(FlueReceipts, taskId, BACKGROUND_CONTEXT);
		if (!receipt || receipt.status === 'absent') {
			return undefined;
		}

		let capabilityId = 'agent.run';
		if (
			receipt.message &&
			typeof receipt.message === 'object' &&
			'attributes' in receipt.message &&
			receipt.message.attributes &&
			typeof (receipt.message.attributes as Record<string, unknown>).capabilityId === 'string'
		) {
			capabilityId = (receipt.message.attributes as Record<string, unknown>).capabilityId as string;
		}

		const questions = await this.questionsForTask(taskId, receipt);
		const hasPendingQuestion = questions.length > 0;

		let state: Operation['state'];
		if (hasPendingQuestion) {
			state = 'input_required';
		} else if (receipt.status === 'admitting') {
			state = 'queued';
		} else {
			state = 'running';
		}

		const inputRequests: McpInputRequest[] | undefined = hasPendingQuestion
			? questions.map((q) => {
					let prompt = `Question ${q.id}`;
					let reason: string | undefined;
					let schema: Record<string, unknown> | undefined;

					if (q.question.kind === 'codemode-approval') {
						prompt = `Approval required for action: ${q.question.pending.map((p) => p.method).join(', ')}`;
						reason = 'approval_required';
						schema = {
							type: 'object',
							properties: {
								decision: { type: 'string', enum: ['approve', 'reject'] },
								reason: { type: 'string' },
							},
							required: ['decision'],
						};
					} else if (q.question.kind === 'mcp-input') {
						prompt = `MCP input required for ${q.question.server}/${q.question.method}`;
						reason = 'input_required';
						schema = {
							type: 'object',
							properties: {
								inputResponses: { type: 'object' },
							},
							required: ['inputResponses'],
						};
					}

					return {
						id: q.id,
						prompt,
						...(schema ? { schema } : {}),
						...(reason ? { reason } : {}),
					};
				})
			: undefined;

		return {
			operationId: taskId,
			capabilityId,
			state,
			revision: 1,
			inputRequests,
			createdAt: receipt.acceptedAt,
			updatedAt: receipt.acceptedAt,
		};
	}

	async cancelTask(taskId: string, _reason?: string): Promise<boolean> {
		const { host } = await this.#open();
		return host.abort(taskId, BACKGROUND_CONTEXT);
	}

	async respondTask(
		taskId: string,
		response: { inputId?: string; input: unknown },
	): Promise<Operation> {
		const { host } = await this.#open();
		const receipt = await host.harness.snapshot(FlueReceipts, taskId, BACKGROUND_CONTEXT);
		if (!receipt || receipt.status === 'absent') {
			throw new Error(`Task '${taskId}' not found.`);
		}

		const questions = await this.questionsForTask(taskId, receipt);
		if (questions.length === 0) {
			throw new Error(`No pending question found to respond to for task '${taskId}'.`);
		}

		if (!response.inputId && questions.length > 1) {
			throw new Error(
				`Multiple pending questions are waiting for task '${taskId}'; 'inputId' is required to disambiguate.`,
			);
		}

		const targetQuestion = response.inputId
			? questions.find((q) => q.id === response.inputId)
			: questions[0];

		if (!targetQuestion) {
			throw new Error(`No pending question found to respond to for task '${taskId}'.`);
		}

		let answer = response.input as FlueAnswer;
		const expectedKind = (targetQuestion.question as { kind?: string } | null)?.kind;
		if (
			typeof response.input === 'object' &&
			response.input !== null &&
			!('kind' in response.input) &&
			expectedKind
		) {
			answer = {
				kind: expectedKind,
				...response.input,
			} as FlueAnswer;
		}

		const res = await this.answerQuestion(targetQuestion.id, answer);
		if (res.status !== 'accepted') {
			throw new Error(`Failed to respond to task '${taskId}': answer status '${res.status}'.`);
		}

		const updated = await this.getTask(taskId);
		if (!updated) {
			throw new Error(`Task '${taskId}' not found after responding.`);
		}
		return updated;
	}

	async listTasks(filter?: { state?: Operation['state'] }): Promise<Operation[]> {
		if (!this.#opened && !hasPiState(await this.#db())) {
			return [];
		}
		const { host } = await this.#open();
		const index = await host.harness.snapshot(FlueReceiptIndex, BACKGROUND_CONTEXT);
		const ids = new Set<string>();
		for (const id of Object.keys(index?.live ?? {})) {
			ids.add(id);
		}
		for (const id of index?.admitting ?? []) {
			ids.add(id);
		}
		for (const id of Object.values(index?.byPiSubmission ?? {})) {
			ids.add(id);
		}

		const tasks: Operation[] = [];
		for (const id of ids) {
			const task = await this.getTask(id);
			if (task) {
				if (filter?.state && task.state !== filter.state) {
					continue;
				}
				tasks.push(task);
			}
		}
		return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async close(): Promise<void> {
		this.#closed = true;
		const opened = this.#opened;
		this.#opened = undefined;
		if (!opened) return;
		const done = await opened.catch(() => undefined);
		if (!done) return;
		done.detach();
		this.#cache?.detach();
		await done.entity?.dispose().catch(() => {});
		await done.host.close(BACKGROUND_CONTEXT);
	}
}
