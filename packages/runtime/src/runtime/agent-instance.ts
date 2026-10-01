/**
 * One agent instance on Pi Durable (PI_UPGRADE_PLAN.md §7 step 8): the
 * platform-neutral core both coordinators drive. It owns the instance's
 * `StreamStorage` and `FluePiHost`, renders the agent function onto the
 * host, admits deliveries, wakes Pi, and serves the public conversation from
 * the canonical log.
 *
 * Open sequence: `StreamStorage.open` → `createFluePiHost` → `host.open` →
 * the one-time legacy import → render (`renderedAgentFrom`) →
 * `host.applyRender`. Re-renders run at admission (the delivery cursor
 * moved) and at every tool-round boundary (`afterTools`), so state written
 * by tools reaches the next request. Pi owns everything else: the loop,
 * compaction, retries, recovery, the inbox, ownership and abort cascades.
 */
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	GenerationTask,
	ROOT_CONVERSATION_ID,
	type ToolRegistration,
	type Tx,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
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
import {
	type EntityWakeRequest,
	type EntityWakeResult,
	handleEntityWake,
} from '../entity/wake-handler.ts';
import { importLegacyConversation } from '../legacy/import.ts';
import type { McpConnectionDefinition, McpConnectionResolver } from '../mcp.ts';
import { createAgentOutputChannel } from '../message-output.ts';
import { FlueInstance, FlueState } from '../pi/docs.ts';
import { executionEnvFromSandbox } from '../pi/execution-env.ts';
import type { FlueAttachmentPort } from '../pi/hooks.ts';
import {
	createFluePiHost,
	type FluePiHost,
	type FlueSettlement,
	type WakeReason,
} from '../pi/host.ts';
import { renderedAgentFrom } from '../pi/registry-bridge.ts';
import { piConversationSource } from '../pi/projection-host.ts';
import { StreamStorage } from '../pi/stream-storage.ts';
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
import { type AttachmentStore, createAttachmentRef } from './attachment-store.ts';
import type { ConversationProjectionSource } from './conversation-source.ts';
import type { ConversationStreamStore } from './conversation-stream-store.ts';
import { ATTACHMENT_CONVERSATION_SCOPE } from './handle-conversation-routes.ts';
import { getRuntimeModels, resolveModel } from './providers.ts';
import { agentStreamPath } from './stream-offsets.ts';

/** The log path of an instance's canonical Pi log (`flue/v1/{agent}/{id}/pi`). */
function piLogPath(agentName: string, instanceId: string): string {
	return `flue/v1/${agentName}/${instanceId}/pi`;
}

export interface FlueAgentInstanceOptions {
	readonly agentName: string;
	readonly instanceId: string;
	readonly agent: Agent;
	/** The Pi index database: DO SQLite on Cloudflare, `node:sqlite` on Node. */
	readonly database: () => SqliteDatabase | Promise<SqliteDatabase>;
	/** The canonical log (Electric, or the persistence adapter's stream store). */
	readonly log: DurableStreamLog;
	/** `await` publishes each commit before it resolves (Node); `async` drains in the background (DO). */
	readonly publish?: 'async' | 'await';
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
	 * the inbox. Enable it where the log reaches every entity — an Electric
	 * server, or one process's shared store (Node).
	 */
	readonly entities?: { readonly subscriptions?: EntitySubscriptionPort } | false;
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
	readonly storage: StreamStorage;
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

export class FlueAgentInstance {
	readonly agentName: string;
	readonly instanceId: string;
	/** The public conversation, projected from the canonical log. */
	readonly source: ConversationProjectionSource;
	readonly logPath: string;
	readonly #options: FlueAgentInstanceOptions;
	readonly #now: () => number;
	#opened: Promise<Opened> | undefined;
	#closed = false;
	#fenced: Error | undefined;
	/** The latest delivered message: what `useDelivery()` reads. */
	#delivery: DeliveredMessage | undefined;
	#pending: PendingWrites = { state: new Map(), data: [] };
	/** State values as of the last render, overlaid by pending writes. */
	#stateSnapshot = new Map<string, unknown>();
	#renderChain: Promise<unknown> = Promise.resolve();
	/** The resolved sandbox and the factory/cwd it came from. */
	#sandbox: {
		factory: SandboxFactory | undefined;
		cwd: string | undefined;
		current: Sandbox | undefined;
		/** `SandboxFactory.tools` over `current`, built once per sandbox. */
		tools?: readonly ToolRegistration[];
	} = { factory: undefined, cwd: undefined, current: undefined };
	#workspace:
		| { sandbox: Sandbox | undefined; context: string; skills: RegisteredSkill[] }
		| undefined;
	readonly #sandboxProxy: Sandbox;
	#toolDeps: FlueToolDeps | undefined;
	readonly #envProxy: ExecutionEnv;
	readonly #envs = new WeakMap<Sandbox, ExecutionEnv>();

	constructor(options: FlueAgentInstanceOptions) {
		this.#options = options;
		this.agentName = options.agentName;
		this.instanceId = options.instanceId;
		this.#now = options.now ?? Date.now;
		this.logPath = piLogPath(options.agentName, options.instanceId);
		this.source = piConversationSource(options.log, this.logPath);
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

	#emit(event: FlueEventInput, observation?: FlueObservationDetail): void {
		try {
			this.#options.events.emitEvent(event, observation);
		} catch {
			// Event delivery never breaks agent work.
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
		const storage = await StreamStorage.open(
			{
				database: await options.database(),
				log: options.log,
				entity: { type: this.agentName, id: this.instanceId },
				path: this.logPath,
				publish: options.publish ?? 'async',
				onFenced: (epoch, reason) => {
					this.#fenced = new Error(
						`[flue] Agent instance ${this.agentName}/${this.instanceId} lost its log to another writer (${reason}, epoch ${epoch}).`,
					);
					this.#report(this.#fenced);
				},
				onReport: (error) => this.#report(error),
				armWake: (atMs) => options.armWake(atMs, { kind: 'outbox' }),
				now: this.#now,
			},
			context,
		);
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
			sandbox: this.#sandboxProxy,
			env: this.#envProxy,
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
		host.registry.hooks.add(
			GenerationTask,
			{
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
			},
			{ key: 'flue.render' },
		);
		host.registry.hooks.add(GenerationTask, telemetry.generationHooks(), { key: 'flue.telemetry' });
		// The entity tools register before the first render picks active tools.
		const entity = options.entities
			? await createEntityRuntime({
					host,
					entity: { type: this.agentName, id: this.instanceId },
					log: options.log,
					cursors: () => storage.cursors,
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
		return { storage, host, telemetry, entity, detach };
	}

	// ─── Rendering ──────────────────────────────────────────────────────────

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
	 * Returns the receipt and the log offset to follow it from.
	 */
	async admit(input: FlueInstanceAdmission): Promise<{ receipt: DispatchReceipt; offset: string }> {
		if (this.#fenced) throw this.#fenced;
		const { host, telemetry } = await this.#open();
		const context = BACKGROUND_CONTEXT;
		const offset = (await this.#options.log.head(this.logPath))?.nextOffset ?? '-1';
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
	 * Wake Pi (an alarm, a timer): publish the outbox and post the relay rows,
	 * fire due entity schedules, then repair admissions, enforce limits and
	 * resume.
	 */
	async wake(reason: WakeReason): Promise<void> {
		if (this.#fenced) return;
		const opened = await this.#open();
		const context = BACKGROUND_CONTEXT;
		await opened.storage.drain().catch((error) => this.#report(error));
		if (opened.entity) await opened.entity.wake(reason, context);
		else await opened.host.wake(reason, context);
	}

	/** An Electric webhook (or a local relay) says these streams have new data: the `__flueWake` body. */
	async wakeEntity(request: EntityWakeRequest): Promise<EntityWakeResult> {
		const opened = await this.#open();
		if (!opened.entity) {
			throw new Error(
				`[flue] Agent instance ${this.agentName}/${this.instanceId} has no entity runtime: configure Electric streams to receive entity wakes.`,
			);
		}
		return handleEntityWake(opened.entity, request, BACKGROUND_CONTEXT);
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
		if (!this.#opened && !(await this.#options.log.head(this.logPath))) {
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

	/** Whether Pi holds no live work and the outbox is drained. */
	async idle(): Promise<boolean> {
		if (!this.#opened) return true;
		const { host, storage } = await this.#open();
		const inspection = await host.harness.inspect(BACKGROUND_CONTEXT);
		return (
			inspection.tasks.length === 0 &&
			inspection.submissions.length === 0 &&
			storage.outbox.pending() === 0
		);
	}

	/** Resolve when every conversation's ordinary work is idle. */
	async waitForIdle(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		if (!this.#opened) return;
		const { host, storage } = await this.#open();
		await host.harness.waitForIdle(context);
		await storage.drain().catch(() => {});
	}

	async close(): Promise<void> {
		this.#closed = true;
		const opened = this.#opened;
		this.#opened = undefined;
		if (!opened) return;
		const done = await opened.catch(() => undefined);
		if (!done) return;
		done.detach();
		await done.entity?.dispose().catch(() => {});
		await done.host.close(BACKGROUND_CONTEXT);
	}
}
