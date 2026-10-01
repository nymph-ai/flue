/**
 * The Cloudflare agent coordinator: one Durable Object = one agent instance
 * = one `FlueAgentInstance` over Pi Durable (docs/cloudflare-native.md).
 *
 * - Storage (rule 1): Pi's own `SqliteStorage` over the object's SQLite
 *   (`do-sqlite-database.ts`), with Flue's tables beside it. Pi's commits
 *   never leave the object (rule 2); reads serve the conversation cache.
 * - Admission (`/__flue/internal/dispatch`, the agent prompt route) →
 *   `FlueAgentInstance.admit` → `FluePiHost.admit`: Flue receipts, the frozen
 *   submission id derivation, payload-conflict 409s and the uid send
 *   condition, then Pi's inbox (a busy run is steered, as Flue joined it).
 * - Doorbell (rule 3): the `__flueWake({ stream, head })` RPC writes the
 *   stream's high-water mark into the wake book and calls `setAlarm(now)` in
 *   the same synchronous turn — one coalesced, atomic storage write — and
 *   returns. It opens nothing.
 * - Pump (rule 4): every alarm runs the Agents SDK's scheduled callbacks
 *   first (Pi's own wakes: the live-task backstop, submission deadlines,
 *   schedules — `schedule()` multiplexes them onto the one alarm), then, while
 *   the wake book is behind, one bounded pump (`entity/pump.ts`), and re-arms
 *   `setAlarm(now)` while it is still behind. The SDK re-computes the alarm
 *   whenever it schedules; Flue re-asserts its own after each of those.
 *
 * Pi owns what this module used to: attempts, leases, reconciliation,
 * recovery, joins and settlement.
 */
import type { FlueContextInternal } from '../client.ts';
import {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	InvalidRequestError,
	SubmissionConflictError,
} from '../errors.ts';
import { createMcpConnectionCache } from '../mcp.ts';
import { FlueAgentInstance } from '../runtime/agent-instance.ts';
import {
	type AttachedAgentSubmissionOptions,
	createDirectAgentSubmissionInput,
	createDispatchAgentSubmissionInput,
} from '../runtime/agent-submissions.ts';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { EntityWakeBook } from '../entity/wake-book.ts';
import { hasPiState } from '../pi/conversation-cache.ts';
import { drainGlobalEventDeliveries } from '../runtime/events.ts';
import { assertAgentDispatchAdmissionInput, handleAgentRequest } from '../runtime/handle-agent.ts';
import {
	handleAgentAttachmentRead,
	handleAgentConversationHead,
	handleAgentConversationRead,
} from '../runtime/handle-conversation-routes.ts';
import { agentStreamPath } from '../runtime/stream-offsets.ts';
import type { EntityDoorbell } from '../entity/webhook-route.ts';
import {
	configuredStreams,
	configuredStreamsLog,
	streamsSubscriptions,
} from '../runtime/streams-config.ts';
import type { SqlStorage } from '../sql-storage.ts';
import type { Agent, DeliveredMessage } from '../types.ts';
import { createSqlConversationStores } from './agent-execution-store.ts';
import { doSqliteDatabase } from './do-sqlite-database.ts';
import type { WakeReason as FlueWakeReason } from '../pi/host.ts';

export const CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH = '/__flue/internal/dispatch';
export const CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH = '/__flue/internal/instance-info';

/** The schedule target every wake rides (kept from the pre-Pi coordinator, so armed rows still fire). */
const FLUE_WAKE_CALLBACK = '__flueWakeAgentSubmissions';
/** The pre-Pi attempt fiber, recovered once after an upgrade. */
const LEGACY_ATTEMPT_FIBER = 'flue:submission-attempt';

interface CloudflareAgentStorage {
	sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
	setAlarm?(scheduledTime: number): Promise<void>;
}

interface CloudflareAgentInstance {
	readonly name: string;
	readonly env: Record<string, unknown>;
	readonly ctx: {
		readonly id: { toString(): string };
		readonly storage: CloudflareAgentStorage;
		waitUntil?(promise: Promise<unknown>): void;
	};
	schedule(
		delaySeconds: number,
		callback: string,
		payload: unknown,
		options: { idempotent: boolean },
	): Promise<unknown>;
}

interface CloudflareAgentRecoveredFiberContext {
	readonly name?: string;
	readonly snapshot?: Record<string, unknown>;
}

interface CloudflareAgentPreparedCoordinator {
	readonly agentName: string;
	readonly conversationStreamStore: ConversationStreamStore;
	readonly attachmentStore: AttachmentStore;
}

interface CloudflareAgentRuntimeOptions {
	readonly agents: ReadonlyArray<{ readonly name: string; readonly agent: Agent }>;
	readonly createContext: (options: {
		readonly instance: CloudflareAgentInstance;
		readonly agentName: string;
		readonly request: Request;
		readonly submissionId?: string;
	}) => FlueContextInternal;
	readonly runWithInstanceContext: <T>(
		instance: CloudflareAgentInstance,
		agentName: string,
		callback: () => T,
	) => T;
}

export interface CloudflareAgentRuntime {
	prepare(options: {
		readonly storage: CloudflareAgentStorage;
		readonly className: string;
		readonly agentName: string;
	}): CloudflareAgentPreparedCoordinator;
	attach(instance: CloudflareAgentInstance, prepared: CloudflareAgentPreparedCoordinator): void;
	onStart(
		instance: CloudflareAgentInstance,
		inherited: () => Promise<unknown> | unknown,
	): Promise<void>;
	/** The `__flueWakeAgentSubmissions` schedule target: one wake of the instance. */
	drainSubmissions(instance: CloudflareAgentInstance, payload?: unknown): Promise<void>;
	onRequest(instance: CloudflareAgentInstance, request: Request): Promise<Response | null>;
	onFiberRecovered(
		instance: CloudflareAgentInstance,
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
	/**
	 * Run the Agents SDK alarm handler inside the instance context — it
	 * dispatches `schedule`/`scheduleEvery`/`queue` callbacks, Flue's wake
	 * among them (`__flueWakeAgentSubmissions`) — then pump entity events
	 * while the wake book is behind.
	 */
	onAlarm(
		instance: CloudflareAgentInstance,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
	/** The `__flueWake({ stream, head })` RPC: the doorbell of a verified Electric wake. */
	wake(
		instance: CloudflareAgentInstance,
		doorbell: EntityDoorbell,
	): Promise<{ readonly recorded: true }>;
}

export function createCloudflareAgentRuntime(
	options: CloudflareAgentRuntimeOptions,
): CloudflareAgentRuntime {
	const coordinators = new WeakMap<CloudflareAgentInstance, CloudflareAgentCoordinator>();
	const coordinatorOf = (instance: CloudflareAgentInstance): CloudflareAgentCoordinator => {
		const coordinator = coordinators.get(instance);
		if (!coordinator)
			throw new Error('[flue] Generated Cloudflare agent coordinator was not initialized.');
		return coordinator;
	};
	return {
		prepare({ storage, className, agentName }) {
			if (!storage?.sql || typeof storage.transactionSync !== 'function') {
				throw new Error(
					`[flue] Cloudflare durable agent class "${className}" requires Durable Object SQLite. ` +
						`Add "${className}" to a Wrangler migration's "new_sqlite_classes" list before its first deploy; ` +
						'do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted ' +
						'to SQLite in place.',
				);
			}
			return { agentName, ...createSqlConversationStores(storage as never, className) };
		},
		attach(instance, prepared) {
			coordinators.set(instance, new CloudflareAgentCoordinator(instance, prepared, options));
		},
		onStart: (instance, inherited) => coordinatorOf(instance).onStart(inherited),
		drainSubmissions: (instance, payload) => coordinatorOf(instance).wakeFromAlarm(payload),
		onRequest: (instance, request) => coordinatorOf(instance).onRequest(request),
		onFiberRecovered: (instance, ctx, inherited) =>
			coordinatorOf(instance).onFiberRecovered(ctx, inherited),
		onAlarm: (instance, inherited) => coordinatorOf(instance).onAlarm(inherited),
		wake: (instance, doorbell) => coordinatorOf(instance).doorbell(doorbell),
	};
}

function isWakeReason(value: unknown): value is FlueWakeReason {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { kind?: unknown }).kind === 'string' &&
		['live-tasks', 'schedule', 'pump', 'dispatch'].includes((value as { kind: string }).kind)
	);
}

class CloudflareAgentCoordinator {
	readonly #instance: CloudflareAgentInstance;
	readonly #prepared: CloudflareAgentPreparedCoordinator;
	readonly #options: CloudflareAgentRuntimeOptions;
	#agentInstance: FlueAgentInstance | undefined;
	#book: EntityWakeBook | undefined;
	/** Live MCP connections of this instance; eviction is the teardown. */
	readonly #mcp = createMcpConnectionCache();

	constructor(
		instance: CloudflareAgentInstance,
		prepared: CloudflareAgentPreparedCoordinator,
		options: CloudflareAgentRuntimeOptions,
	) {
		this.#instance = instance;
		this.#prepared = prepared;
		this.#options = options;
	}

	get #agentName(): string {
		return this.#prepared.agentName;
	}

	#run<T>(callback: () => T): T {
		return this.#options.runWithInstanceContext(this.#instance, this.#agentName, callback);
	}

	#agent(): Agent {
		const agent = this.#options.agents.find((record) => record.name === this.#agentName)?.agent;
		if (!agent) throw new Error(`[flue] Agent "${this.#agentName}" has no registered definition.`);
		return agent;
	}

	/** The instance core, created on first use. */
	#core(): FlueAgentInstance {
		if (this.#agentInstance) return this.#agentInstance;
		const instance = this.#instance;
		const storage = this.#storage();
		const events = this.#options.createContext({
			instance,
			agentName: this.#agentName,
			request: new Request('https://flue.invalid/_instance', { method: 'POST' }),
		});
		this.#agentInstance = new FlueAgentInstance({
			agentName: this.#agentName,
			instanceId: instance.name,
			agent: this.#agent(),
			database: () => doSqliteDatabase(storage),
			// Entities need streams every Durable Object reaches: Electric.
			entities: this.#entities(),
			attachments: this.#prepared.attachmentStore,
			legacy: this.#prepared.conversationStreamStore,
			armWake: (atMs, reason) => this.#armWake(atMs, reason),
			events,
			mcp: this.#mcp,
			onReport: (error) =>
				console.error(
					'[flue:pi]',
					{ agentName: this.#agentName, instanceId: instance.name },
					error,
				),
		});
		return this.#agentInstance;
	}

	#storage(): Parameters<typeof doSqliteDatabase>[0] {
		return this.#instance.ctx.storage as unknown as Parameters<typeof doSqliteDatabase>[0];
	}

	#entities():
		| {
				log: NonNullable<ReturnType<typeof configuredStreamsLog>>;
				subscriptions?: ReturnType<typeof streamsSubscriptions>;
		  }
		| false {
		const streams = configuredStreams(this.#instance.env);
		const log = configuredStreamsLog(this.#instance.env);
		if (!streams || !log) return false;
		const webhookUrl = streams.webhook?.url;
		return webhookUrl ? { log, subscriptions: streamsSubscriptions(streams, webhookUrl) } : { log };
	}

	/** The wake book in this object's SQLite (`entity/wake-book.ts`). */
	#wakeBook(): EntityWakeBook {
		this.#book ??= new EntityWakeBook(doSqliteDatabase(this.#storage()));
		return this.#book;
	}

	/** Whether entity events wait to be pumped; never opens the instance. */
	#behind(): boolean {
		if (!configuredStreams(this.#instance.env)) return false;
		try {
			return this.#wakeBook().behind();
		} catch {
			return false;
		}
	}

	/** `setAlarm(now)`: the alarm is the pump. */
	#alarmNow(): Promise<void> {
		const setAlarm = this.#instance.ctx.storage.setAlarm;
		if (typeof setAlarm !== 'function')
			throw new Error('[flue] This Durable Object storage has no setAlarm().');
		return setAlarm.call(this.#instance.ctx.storage, Date.now());
	}

	/**
	 * Arm a wake on the Durable Object alarm through the Agents SDK
	 * `schedule()`. Non-idempotent: an idempotent arm could dedupe onto the
	 * row that is executing right now, which the SDK deletes after it returns.
	 */
	async #armWake(atMs: number, reason: FlueWakeReason): Promise<void> {
		if (typeof this.#instance.schedule !== 'function') {
			throw new Error(
				'[flue] The installed "agents" package does not provide the required Cloudflare Agents SDK method "schedule". Upgrade @flue/vite (which supplies the Cloudflare Agents SDK), or remove the "agents" dependency from your project if it declares an older one.',
			);
		}
		const delaySeconds = Math.max(0, Math.ceil((atMs - Date.now()) / 1000));
		await this.#instance.schedule(delaySeconds, FLUE_WAKE_CALLBACK, reason, { idempotent: false });
		// `schedule()` re-computed the alarm from the SDK's own rows; the pump's comes first.
		if (this.#behind()) await this.#alarmNow();
	}

	/** Whether this Durable Object has Pi state to resume (it served an agent before). */
	#hasPiState(): boolean {
		try {
			return hasPiState(doSqliteDatabase(this.#storage()));
		} catch {
			return false;
		}
	}

	onStart(inherited: () => Promise<unknown> | unknown): Promise<void> {
		return this.#run(async () => {
			// A restarted isolate resumes Pi's interrupted work: arm a wake before
			// the (possibly extension-authored) onStart, so it is in place even if
			// that throws.
			if (this.#hasPiState()) await this.#armWake(Date.now(), { kind: 'live-tasks' });
			else if (this.#behind()) await this.#alarmNow();
			await inherited();
		});
	}

	/** One scheduled wake (Pi's backstop, a deadline, a schedule): wake Pi, pumping first. */
	wakeFromAlarm(payload?: unknown): Promise<void> {
		return this.#run(async () => {
			const reason = isWakeReason(payload) ? payload : { kind: 'live-tasks' as const };
			if (!this.#hasPiState() && reason.kind === 'live-tasks') return;
			try {
				await this.#core().wake(reason);
			} finally {
				this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
		});
	}

	/**
	 * The alarm: the Agents SDK's due callbacks, then one bounded pump while
	 * the wake book is behind, re-armed `setAlarm(now)` while it still is.
	 * Turns the pump admits run on after the handler returns; Pi's live-task
	 * backstop resumes them if the object is evicted first.
	 */
	onAlarm(inherited: () => Promise<unknown> | unknown): Promise<unknown> {
		return this.#run(async () => {
			try {
				return await inherited();
			} finally {
				if (this.#behind()) {
					try {
						await this.#core().wake({ kind: 'pump' });
					} finally {
						if (this.#behind()) await this.#alarmNow();
						this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
					}
				}
			}
		});
	}

	/**
	 * The `__flueWake({ stream, head })` RPC body (rule 3): record the
	 * high-water mark and `setAlarm(now)` in one synchronous turn — no await
	 * between them, so they commit as one write — and resolve once that write
	 * is durable. The webhook route acks only after this resolves.
	 */
	doorbell(doorbell: EntityDoorbell): Promise<{ readonly recorded: true }> {
		if (
			typeof doorbell?.stream !== 'string' ||
			doorbell.stream.length === 0 ||
			typeof doorbell.head !== 'string' ||
			doorbell.head.length === 0
		) {
			return Promise.reject(
				new InvalidRequestError({ reason: 'A doorbell needs { stream, head }.' }),
			);
		}
		this.#wakeBook().ring(doorbell.stream, doorbell.head);
		return this.#alarmNow().then(() => ({ recorded: true as const }));
	}

	/**
	 * A pre-Pi attempt fiber surviving an upgrade: its work is gone (the legacy
	 * loop no longer exists); resolve it so the SDK forgets the row, and wake.
	 */
	onFiberRecovered(
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> {
		return this.#run(async () => {
			if (ctx.name !== LEGACY_ATTEMPT_FIBER) return inherited();
			await this.#armWake(Date.now(), { kind: 'live-tasks' });
		});
	}

	onRequest(request: Request): Promise<Response | null> {
		return this.#run(async () => {
			try {
				return await this.#route(request);
			} finally {
				this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
		});
	}

	/** A pre-upgrade instance is imported before its first read, so reads see its history. */
	async #ensureImported(): Promise<void> {
		const core = this.#core();
		const legacyPath = agentStreamPath(this.#agentName, this.#instance.name);
		if (await this.#prepared.conversationStreamStore.getMeta(legacyPath)) await core.host();
	}

	async #route(request: Request): Promise<Response | null> {
		if (isInternalDispatchRequest(request)) return this.#admitDispatch(request);
		if (isInternalInstanceInfoRequest(request)) return Response.json(await this.#core().info());
		if (isAbortRequest(request, this.#agentName, this.#instance.name)) {
			return Response.json({ aborted: await this.#core().abort() });
		}
		const method = request.method;
		if (method === 'GET' || method === 'HEAD') {
			await this.#ensureImported();
			const core = this.#core();
			// Attachment bytes: the outer Worker rewrote the request onto the
			// canonical `/agents/<name>/<id>/attachments/<id>` path; match the
			// exact tail so an agent named "attachments" still reads its stream.
			const segments = new URL(request.url).pathname.split('/');
			const attachmentId =
				method === 'GET' &&
				segments.length >= 4 &&
				segments[segments.length - 2] === 'attachments' &&
				segments[segments.length - 3] === this.#instance.name &&
				segments[segments.length - 4] === this.#agentName
					? decodeURIComponent(segments[segments.length - 1] as string)
					: undefined;
			if (attachmentId) {
				return handleAgentAttachmentRead({
					source: core.source,
					attachmentStore: this.#prepared.attachmentStore,
					streamPath: agentStreamPath(this.#agentName, this.#instance.name),
					attachmentId,
				});
			}
			if (method === 'HEAD') return handleAgentConversationHead(core.source, core.logPath);
			return handleAgentConversationRead({ source: core.source, request });
		}
		return handleAgentRequest({
			request,
			id: this.#instance.name,
			agentName: this.#agentName,
			admitAttachedSubmission: (message, options) => this.#admitDirect(message, options),
		});
	}

	async #admitDirect(message: DeliveredMessage, options: AttachedAgentSubmissionOptions = {}) {
		const input = await createDirectAgentSubmissionInput({
			agent: this.#agentName,
			id: this.#instance.name,
			message,
			...(options.initialData !== undefined ? { initialData: options.initialData } : {}),
			...(options.traceCarrier ? { traceCarrier: options.traceCarrier } : {}),
			...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
		});
		const { receipt, offset } = await this.#core().admit({
			kind: 'direct',
			submissionId: input.submissionId,
			message: input.message,
			...(input.initialData !== undefined ? { initialData: input.initialData } : {}),
			...(options.uid !== undefined ? { uid: options.uid } : {}),
			acceptedAt: input.acceptedAt,
			...(input.traceCarrier ? { traceCarrier: input.traceCarrier } : {}),
		});
		return {
			submissionId: receipt.submissionId,
			offset: receipt.deduplicated ? '-1' : offset,
			uid: receipt.uid as string,
			...(receipt.deduplicated ? { deduplicated: true as const } : {}),
		};
	}

	async #admitDispatch(request: Request): Promise<Response> {
		const input: unknown = await request.json();
		assertAgentDispatchAdmissionInput(input);
		if (input.agent !== this.#agentName || input.id !== this.#instance.name) {
			return new Response('Invalid internal dispatch target.', { status: 400 });
		}
		if (!this.#options.agents.some((record) => record.name === this.#agentName)) {
			return new Response('Dispatch target unavailable.', { status: 404 });
		}
		const submission = createDispatchAgentSubmissionInput(input);
		try {
			const { receipt } = await this.#core().admit({
				kind: 'dispatch',
				submissionId: submission.submissionId,
				message: submission.message,
				...(submission.initialData !== undefined ? { initialData: submission.initialData } : {}),
				...(input.uid !== undefined ? { uid: input.uid } : {}),
				acceptedAt: submission.acceptedAt,
			});
			return Response.json(receipt);
		} catch (error) {
			// Structured body so the dispatch() caller can rehydrate the typed
			// admission error (`type` selects the class; `uid` restores the
			// instance-exists 409's incarnation; `submissionId` the conflict's).
			if (
				error instanceof InvalidRequestError ||
				error instanceof AgentInstanceNotFoundError ||
				error instanceof AgentInstanceExistsError ||
				error instanceof SubmissionConflictError
			) {
				return Response.json(
					{
						type: error.type,
						error: error.message,
						details: error.details,
						...(error instanceof AgentInstanceExistsError ? { uid: error.uid } : {}),
						...(error instanceof SubmissionConflictError
							? { submissionId: error.submissionId }
							: {}),
					},
					{ status: error.status },
				);
			}
			throw error;
		}
	}
}

function isInternalDispatchRequest(request: Request): boolean {
	return (
		request.method === 'POST' &&
		new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH
	);
}

function isInternalInstanceInfoRequest(request: Request): boolean {
	return (
		request.method === 'GET' &&
		new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH
	);
}

/**
 * Whether the request is an abort for this agent instance
 * (`POST .../agents/<name>/<id>/abort`). Matched by exact tail position so an
 * agent or instance named "abort" cannot misroute.
 */
function isAbortRequest(request: Request, agentName: string, instanceName: string): boolean {
	if (request.method !== 'POST') return false;
	const segments = new URL(request.url).pathname.split('/');
	const n = segments.length;
	if (n < 4) return false;
	return (
		segments[n - 1] === 'abort' &&
		decodeURIComponent(segments[n - 2] as string) === instanceName &&
		decodeURIComponent(segments[n - 3] as string) === agentName
	);
}
