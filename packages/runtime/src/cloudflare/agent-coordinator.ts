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
 * - The wake: the object's own alarm, which Flue owns. Every wake is a full
 *   wake — pump what the wake book holds behind, fire due entity schedules,
 *   repair admissions, enforce deadlines, resume Pi — and re-derives each
 *   later deadline from durable state, so the alarm only ever needs the
 *   earliest one. The alarm time is the record: an arm at or after the armed
 *   time writes nothing; an earlier one is one `setAlarm`. While the alarm
 *   runs, the arms it makes fold into one `setAlarm` at its end — now while
 *   the pump is still behind (rule 4), the earliest asked-for time otherwise,
 *   nothing when nothing is left to wake for (the platform has already
 *   cleared the alarm that fired). A failed wake throws; the platform retries
 *   the alarm.
 * - Doorbell (rule 3): the `__flueWake({ stream, head })` RPC writes the
 *   stream's high-water mark into the wake book and, when that leaves the
 *   stream behind, `setAlarm(now)`, in the same synchronous turn — one
 *   coalesced, atomic storage write — and resolves once it is durable. A
 *   duplicate or stale doorbell writes nothing.
 *
 * Kept on purpose, not moved onto an Agents SDK capability (the object is
 * composed with the SDK's `Lifecycle` for addressing, startup and capability
 * dispatch, `flue-agent-class.ts`):
 * - The alarm, not Lifecycle's job queue (`lifecycle.jobs`, which Scheduler,
 *   Queue and Tasks ride). Measured on workerd, a queued wake costs a row for
 *   the job, a `markRunning` update, a completion delete or reschedule, a
 *   deadman `setAlarm` and a re-arm `setAlarm` — each billed as a row
 *   written — where Flue's costs one `setAlarm`, or nothing when the alarm
 *   is already early enough. The queue owns the physical alarm outright
 *   (every re-arm overwrites or deletes it), so the two cannot share it.
 * - Pi Durable, not `agents/tasks`: Pi is the durable execution engine
 *   (sessions, tasks, tool replay, compaction); a second journal beside it
 *   would duplicate every step in rows.
 * - The wake book, not `agents/queue`: a doorbell is a high-water mark per
 *   stream (one row, updated in place), and the pump reads Electric from a
 *   cursor; a queue item per event would cost rows per event and lose the
 *   coalescing of duplicate and stale webhooks.
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
import type { Operation } from '../mcp-server/types.ts';
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
import {
	answerResponse,
	matchQuestionPath,
	parseAnswerRequest,
	questionsResponse,
} from '../runtime/question-routes.ts';
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

export const CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH = '/__flue/internal/dispatch';
export const CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH = '/__flue/internal/instance-info';

interface CloudflareAgentStorage {
	sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
	getAlarm?(): Promise<number | null>;
	setAlarm?(scheduledTime: number): Promise<void>;
}

/** The slice of the Agents SDK `Lifecycle` Flue uses (`agents/lifecycle`). */
export interface LifecycleLike {
	readonly name: string;
	start(): Promise<void>;
}

interface CloudflareAgentInstance {
	readonly name: string;
	readonly env: Record<string, unknown>;
	readonly ctx: {
		readonly id: { toString(): string };
		readonly storage: CloudflareAgentStorage;
		waitUntil?(promise: Promise<unknown>): void;
	};
	readonly lifecycle: LifecycleLike;
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
	/** Bind a coordinator to a newly constructed instance. Touches no storage. */
	attach(
		instance: CloudflareAgentInstance,
		options: { readonly className: string; readonly agentName: string },
	): void;
	/** Run `callback` inside the instance context (every entry boundary does). */
	run<T>(instance: CloudflareAgentInstance, callback: () => T): T;
	onRequest(instance: CloudflareAgentInstance, request: Request): Promise<Response | null>;
	/** The alarm: Flue's wake. */
	onAlarm(instance: CloudflareAgentInstance): Promise<void>;
	/** The `__flueWake({ stream, head })` RPC: the doorbell of a verified Electric wake. */
	wake(
		instance: CloudflareAgentInstance,
		doorbell: EntityDoorbell,
	): Promise<{ readonly recorded: true }>;
	submitTask(
		instance: CloudflareAgentInstance,
		params: { capabilityId: string; payload?: Record<string, unknown>; correlationId?: string },
	): Promise<{ taskId: string; state: Operation['state'] }>;
	getTask(instance: CloudflareAgentInstance, taskId: string): Promise<Operation | undefined>;
	cancelTask(instance: CloudflareAgentInstance, taskId: string, reason?: string): Promise<boolean>;
	respondTask(
		instance: CloudflareAgentInstance,
		taskId: string,
		response: { inputId?: string; input: unknown },
	): Promise<Operation>;
	listTasks(
		instance: CloudflareAgentInstance,
		filter?: { state?: Operation['state'] },
	): Promise<Operation[]>;
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
		attach(instance, { className, agentName }) {
			const storage = instance.ctx.storage;
			if (!storage?.sql || typeof storage.transactionSync !== 'function') {
				throw new Error(
					`[flue] Cloudflare durable agent class "${className}" requires Durable Object SQLite. ` +
						`Add "${className}" to a Wrangler migration's "new_sqlite_classes" list before its first deploy; ` +
						'do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted ' +
						'to SQLite in place.',
				);
			}
			coordinators.set(
				instance,
				new CloudflareAgentCoordinator(
					instance,
					{ agentName, ...createSqlConversationStores(storage as never) },
					options,
				),
			);
		},
		run: (instance, callback) => coordinatorOf(instance).run(callback),
		onRequest: (instance, request) => coordinatorOf(instance).onRequest(request),
		onAlarm: (instance) => coordinatorOf(instance).onAlarm(),
		wake: (instance, doorbell) => coordinatorOf(instance).doorbell(doorbell),
		submitTask: (instance, params) => coordinatorOf(instance).submitTask(params),
		getTask: (instance, taskId) => coordinatorOf(instance).getTask(taskId),
		cancelTask: (instance, taskId, reason) => coordinatorOf(instance).cancelTask(taskId, reason),
		respondTask: (instance, taskId, response) =>
			coordinatorOf(instance).respondTask(taskId, response),
		listTasks: (instance, filter) => coordinatorOf(instance).listTasks(filter),
	};
}

interface CloudflareAgentPreparedCoordinator {
	readonly agentName: string;
	readonly conversationStreamStore: ConversationStreamStore;
	readonly attachmentStore: AttachmentStore;
}

class CloudflareAgentCoordinator {
	readonly #instance: CloudflareAgentInstance;
	readonly #prepared: CloudflareAgentPreparedCoordinator;
	readonly #options: CloudflareAgentRuntimeOptions;
	#agentInstance: FlueAgentInstance | undefined;
	#book: EntityWakeBook | undefined;
	/**
	 * While the alarm runs: the earliest time an arm asked for since it
	 * started (`Infinity` for none), set once at its end.
	 */
	#driving: { rearmAt: number } | undefined;
	/** Arms outside the alarm, one at a time: each reads the alarm before it writes. */
	#arming: Promise<void> = Promise.resolve();
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

	run<T>(callback: () => T): T {
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
			armWake: (atMs) => this.#armWake(atMs),
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
		return this.#wakeBook().behind();
	}

	#alarmStorage(): Required<Pick<CloudflareAgentStorage, 'getAlarm' | 'setAlarm'>> {
		const storage = this.#instance.ctx.storage;
		if (typeof storage.getAlarm !== 'function' || typeof storage.setAlarm !== 'function')
			throw new Error('[flue] This Durable Object storage has no alarm API.');
		return {
			getAlarm: () => (storage.getAlarm as () => Promise<number | null>).call(storage),
			setAlarm: (at) => (storage.setAlarm as (at: number) => Promise<void>).call(storage, at),
		};
	}

	/**
	 * Arm a wake at `atMs`. While the alarm runs, the arm folds into the one
	 * `setAlarm` at its end. Otherwise the alarm moves earlier, or stays: an
	 * alarm already due at or before `atMs` serves this wake too, and costs
	 * nothing.
	 */
	#armWake(atMs: number): Promise<void> {
		if (this.#driving) {
			this.#driving.rearmAt = Math.min(this.#driving.rearmAt, atMs);
			return Promise.resolve();
		}
		const alarms = this.#alarmStorage();
		const arm = this.#arming.then(async () => {
			const armed = await alarms.getAlarm();
			if (armed === null || armed > atMs) await alarms.setAlarm(atMs);
		});
		this.#arming = arm.catch(() => {});
		return arm;
	}

	/** Whether this Durable Object has Pi state to resume (it served an agent before). */
	#hasPiState(): boolean {
		return hasPiState(doSqliteDatabase(this.#storage()));
	}

	/**
	 * The alarm: one full wake — pump, schedules, deadlines, Pi — inside the
	 * instance context, then one `setAlarm` for what it left: now while the
	 * pump is still behind, else the earliest time an arm asked for. A new
	 * instance with nothing to pump never opens Pi.
	 *
	 * Turns the wake admits run on after it returns; Pi's live-task backstop,
	 * armed by this wake while they are live, resumes them if the object is
	 * evicted or redeployed first.
	 */
	onAlarm(): Promise<void> {
		return this.run(async () => {
			if (!this.#behind() && !this.#hasPiState()) return;
			const driving = { rearmAt: Number.POSITIVE_INFINITY };
			this.#driving = driving;
			let behind = false;
			try {
				behind = (await this.#core().wake({ kind: 'live-tasks' })).behind;
			} finally {
				this.#driving = undefined;
				this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
			const next = behind ? Date.now() : driving.rearmAt;
			if (next !== Number.POSITIVE_INFINITY) await this.#armWake(next);
		});
	}

	/**
	 * The `__flueWake({ stream, head })` RPC body (rule 3): record the
	 * high-water mark and, when the stream is behind, `setAlarm(now)` — no
	 * await between them, so they commit as one write — and resolve once the
	 * alarm is set. The webhook route acks only
	 * after this resolves. A doorbell that records nothing new (a duplicate or
	 * stale webhook, or one for events already pumped) writes nothing.
	 */
	async doorbell(doorbell: EntityDoorbell): Promise<{ readonly recorded: true }> {
		if (
			typeof doorbell?.stream !== 'string' ||
			doorbell.stream.length === 0 ||
			typeof doorbell.head !== 'string' ||
			doorbell.head.length === 0
		) {
			throw new InvalidRequestError({ reason: 'A doorbell needs { stream, head }.' });
		}
		const alarms = this.#alarmStorage();
		// While the alarm runs, a ring folds into its end; the head is durable
		// now, and a wake that dies is retried by the platform.
		const armed = this.#driving ? 0 : await alarms.getAlarm();
		const now = Date.now();
		if (!this.#wakeBook().ring(doorbell.stream, doorbell.head)) return { recorded: true };
		if (this.#driving) this.#driving.rearmAt = now;
		else if (armed === null || armed > now) await alarms.setAlarm(now);
		return { recorded: true };
	}

	onRequest(request: Request): Promise<Response | null> {
		return this.run(async () => {
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
		const question = matchQuestionPath(
			new URL(request.url).pathname,
			this.#agentName,
			this.#instance.name,
		);
		if (question?.kind === 'list' && request.method === 'GET') {
			return questionsResponse(await this.#core().pendingQuestions());
		}
		if (question?.kind === 'answer' && request.method === 'POST') {
			const answer = await parseAnswerRequest(request);
			return answerResponse(
				question.questionId,
				await this.#core().answerQuestion(question.questionId, answer.answer, {
					...(answer.from ? { from: answer.from } : {}),
					...(answer.answerId ? { answerId: answer.answerId } : {}),
				}),
			);
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

	submitTask(params: {
		capabilityId: string;
		payload?: Record<string, unknown>;
		correlationId?: string;
	}): Promise<{ taskId: string; state: Operation['state'] }> {
		return this.run(async () => {
			try {
				return await this.#core().submitTask(params);
			} finally {
				this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
		});
	}

	getTask(taskId: string): Promise<Operation | undefined> {
		return this.run(async () => {
			try {
				return await this.#core().getTask(taskId);
			} finally {
				this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
		});
	}

	cancelTask(taskId: string, reason?: string): Promise<boolean> {
		return this.run(async () => {
			try {
				return await this.#core().cancelTask(taskId, reason);
			} finally {
				this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
		});
	}

	respondTask(
		taskId: string,
		response: { inputId?: string; input: unknown },
	): Promise<Operation> {
		return this.run(async () => {
			try {
				return await this.#core().respondTask(taskId, response);
			} finally {
				this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
		});
	}

	listTasks(filter?: { state?: Operation['state'] }): Promise<Operation[]> {
		return this.run(async () => {
			try {
				return await this.#core().listTasks(filter);
			} finally {
				this.#instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
		});
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
