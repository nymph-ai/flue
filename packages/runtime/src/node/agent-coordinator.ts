/**
 * The Node agent coordinator: a process-wide set of `FlueAgentInstance`s over
 * Pi Durable, the same shape as the Cloudflare coordinator
 * (docs/cloudflare-native.md). Each instance keeps Pi's own `SqliteStorage`
 * and Flue's tables in one `node:sqlite` database: a file per instance under
 * `FLUE_PI_DIR` when that is set, else in memory for the process lifetime.
 * Wakes are process timers.
 *
 * Entities: their inbox and events streams live on the configured Electric
 * server (`streams-config.ts`), else in the persistence adapter's stream
 * store. One process holds every local entity, so an append to an instance's
 * inbox rings its doorbell directly; the timer it arms is the pump.
 *
 * Pi owns what this module used to: claims, leases, heartbeats,
 * reconciliation, joins and settlement. An instance that a previous process
 * left with work in flight resumes when it is next opened (any admission or
 * read of it).
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { FlueContextInternal } from '../client.ts';
import { RuntimeUnavailableError } from '../errors.ts';
import { createMcpConnectionCache, type McpConnectionCache } from '../mcp.ts';
import { FlueAgentInstance } from '../runtime/agent-instance.ts';
import {
	type AttachedAgentSubmissionAdmission,
	createDirectAgentSubmissionInput,
	createDispatchAgentSubmissionInput,
} from '../runtime/agent-submissions.ts';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import type { ConversationProjectionSource } from '../runtime/conversation-source.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import type { DispatchInput, DispatchQueue } from '../runtime/dispatch-queue.ts';
import type { CreateAgentContextFn } from '../runtime/handle-agent.ts';
import { handleAgentAttachmentRead } from '../runtime/handle-conversation-routes.ts';
import type { RuntimeActivityGate } from '../runtime/runtime-activity-gate.ts';
import { agentStreamPath } from '../runtime/stream-offsets.ts';
import { configuredStreamsLog } from '../runtime/streams-config.ts';
import { entityOfInboxPath } from '../entity/paths.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import { conversationStreamStoreLog } from '../streams/store-bridge-log.ts';
import { join } from 'node:path';
import type { PendingQuestion } from '../pi/questions.ts';
import type { AnswerRequest, AnswerResult } from '../runtime/question-routes.ts';
import type { Agent, DeliveredMessage, DispatchReceipt } from '../types.ts';
import { openNodeSqliteDatabase } from './node-sqlite-database.ts';

export interface NodeAgentCoordinator {
	/** Admit a dispatch; processing is asynchronous. Deduplicates keyed retries; a conflicting replay throws. */
	admitDispatch(input: DispatchInput): Promise<DispatchReceipt>;
	/**
	 * Abort all in-flight and queued work of an agent instance. Resolves
	 * `true` when there was work to abort; the aborted settlement arrives on
	 * the conversation.
	 */
	abortInstance(agentName: string, instanceId: string): Promise<boolean>;
	/** The direct (HTTP prompt) admission of one instance. */
	createAdmission(agentName: string, instanceId: string): AttachedAgentSubmissionAdmission;
	/** The public conversation of one instance; opening it resumes interrupted work. */
	conversationSource(agentName: string, instanceId: string): Promise<ConversationProjectionSource>;
	/** Serve one attachment's bytes. */
	readAttachment(agentName: string, instanceId: string, attachmentId: string): Promise<Response>;
	/** Existence and uid of an instance, without creating it. */
	instanceInfo(agentName: string, instanceId: string): Promise<{ exists: boolean; uid?: string }>;
	/** The questions an instance waits on (rule 9). */
	pendingQuestions(agentName: string, instanceId: string): Promise<PendingQuestion[]>;
	/** Answer one of an instance's questions through its inbox. */
	answerQuestion(
		agentName: string,
		instanceId: string,
		questionId: string,
		request: AnswerRequest,
	): Promise<AnswerResult>;
	/** Resolves when every open instance is idle. For tests and graceful shutdown. */
	waitForIdle(): Promise<void>;
	/**
	 * Graceful shutdown: stop admitting, wait (bounded) for in-flight work,
	 * then close every instance. Work still running is interrupted and
	 * resumes when its instance is next opened.
	 */
	shutdown(timeoutMs?: number): Promise<void>;
}

/** `log`, ringing `ring` after every append to an entity inbox. */
function ringInboxesLocally(
	log: DurableStreamLog,
	ring: (entity: { type: string; id: string }, path: string, head: string) => void,
): DurableStreamLog {
	return {
		ensure: (path, signal) => log.ensure(path, signal),
		async append(path, messages, signal) {
			const appended = await log.append(path, messages, signal);
			const entity = entityOfInboxPath(path);
			if (entity) ring(entity, path, appended.nextOffset);
			return appended;
		},
		read: (path, from, options) => log.read(path, from, options),
		head: (path, signal) => log.head(path, signal),
	};
}

function instanceFile(directory: string, agentName: string, instanceId: string): string {
	return join(directory, encodeURIComponent(agentName), `${encodeURIComponent(instanceId)}.sqlite`);
}

/** A `DispatchQueue` backed by a {@link NodeAgentCoordinator}: durable admission, asynchronous processing. */
export function createNodeDispatchQueue(coordinator: NodeAgentCoordinator): DispatchQueue {
	return { enqueue: (input) => coordinator.admitDispatch(input) };
}

export function createNodeAgentCoordinator(options: {
	agents: ReadonlyArray<{ name: string; agent: Agent }>;
	createContext: CreateAgentContextFn;
	conversationStreamStore: ConversationStreamStore;
	attachmentStore: AttachmentStore;
	/** Runtime environment (Electric streams configuration, event contexts). */
	env?: Record<string, unknown>;
	activityGate?: RuntimeActivityGate;
}): NodeAgentCoordinator {
	const { agents, createContext, conversationStreamStore, attachmentStore, activityGate } = options;
	const env = options.env ?? {};
	const instances = new Map<string, FlueAgentInstance>();
	const piDirectory =
		typeof env.FLUE_PI_DIR === 'string' && env.FLUE_PI_DIR !== '' ? env.FLUE_PI_DIR : undefined;
	// One process holds every local entity: an append to an instance's inbox
	// rings its doorbell directly (Cloudflare rings through Electric webhooks).
	const log = ringInboxesLocally(
		configuredStreamsLog(env) ?? conversationStreamStoreLog(conversationStreamStore),
		(entity, path, head) => {
			if (stopping || !agents.some((record) => record.name === entity.type)) return;
			void instanceOf(entity.type, entity.id)
				.ring(path, head)
				.catch((error) => console.error('[flue:pi] entity doorbell failed', error));
		},
	);
	const mcpCaches = new Map<string, McpConnectionCache>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let stopping = false;

	function agentOf(agentName: string): Agent {
		const agent = agents.find((record) => record.name === agentName)?.agent;
		if (!agent) throw new Error(`[flue] Agent "${agentName}" has no registered definition.`);
		return agent;
	}

	function instanceOf(agentName: string, instanceId: string): FlueAgentInstance {
		const key = agentStreamPath(agentName, instanceId);
		let instance = instances.get(key);
		if (instance) return instance;
		const mcp = createMcpConnectionCache();
		mcpCaches.set(key, mcp);
		const events: FlueContextInternal = createContext({
			id: instanceId,
			agentName,
			request: new Request('https://flue.invalid/_instance', { method: 'POST' }),
		});
		const armWake = (atMs: number): void => {
			if (stopping) return;
			const timer = setTimeout(
				() => {
					timers.delete(timer);
					if (stopping) return;
					void created
						.wake()
						.catch((error) => console.error('[flue:pi] wake failed', error));
				},
				Math.max(0, atMs - Date.now()),
			);
			timer.unref?.();
			timers.add(timer);
		};
		const created: FlueAgentInstance = new FlueAgentInstance({
			agentName,
			instanceId,
			agent: agentOf(agentName),
			database: () =>
				openNodeSqliteDatabase(
					piDirectory ? instanceFile(piDirectory, agentName, instanceId) : ':memory:',
				),
			attachments: attachmentStore,
			legacy: conversationStreamStore,
			armWake: (atMs: number) => armWake(atMs),
			events,
			mcp,
			entities: { log },
			onReport: (error) => console.error('[flue:pi]', { agentName, instanceId }, error),
		});
		instance = created;
		instances.set(key, instance);
		return instance;
	}

	/** Open an instance and resume what a previous process left in flight. */
	async function opened(agentName: string, instanceId: string): Promise<FlueAgentInstance> {
		const instance = instanceOf(agentName, instanceId);
		const first = (await instance.info()).exists;
		if (first) await instance.wake({ kind: 'live-tasks' });
		return instance;
	}

	async function admit<T>(run: () => Promise<T>): Promise<T> {
		if (stopping) throw new RuntimeUnavailableError({ state: 'draining' });
		// The lease scopes the admission call itself (pause() rejects new ones);
		// background work drains through waitForIdle()/shutdown().
		const lease = activityGate?.enter();
		try {
			return await run();
		} finally {
			lease?.release();
		}
	}

	return {
		admitDispatch(input) {
			return admit(async () => {
				agentOf(input.agent);
				const submission = createDispatchAgentSubmissionInput(input);
				const { receipt } = await instanceOf(input.agent, input.id).admit({
					kind: 'dispatch',
					submissionId: submission.submissionId,
					message: submission.message,
					...(submission.initialData !== undefined ? { initialData: submission.initialData } : {}),
					...(input.uid !== undefined ? { uid: input.uid } : {}),
					acceptedAt: submission.acceptedAt,
				});
				return receipt;
			});
		},

		async abortInstance(agentName, instanceId) {
			const instance = instanceOf(agentName, instanceId);
			if (!(await instance.info()).exists) return false;
			return instance.abort();
		},

		createAdmission(agentName, instanceId) {
			return (message: DeliveredMessage, admission = {}) =>
				admit(async () => {
					agentOf(agentName);
					const input = await createDirectAgentSubmissionInput({
						agent: agentName,
						id: instanceId,
						message,
						...(admission.initialData !== undefined ? { initialData: admission.initialData } : {}),
						...(admission.traceCarrier ? { traceCarrier: admission.traceCarrier } : {}),
						...(admission.idempotencyKey !== undefined
							? { idempotencyKey: admission.idempotencyKey }
							: {}),
					});
					const { receipt, offset } = await instanceOf(agentName, instanceId).admit({
						kind: 'direct',
						submissionId: input.submissionId,
						message: input.message,
						...(input.initialData !== undefined ? { initialData: input.initialData } : {}),
						...(admission.uid !== undefined ? { uid: admission.uid } : {}),
						acceptedAt: input.acceptedAt,
						...(input.traceCarrier ? { traceCarrier: input.traceCarrier } : {}),
					});
					return {
						submissionId: receipt.submissionId,
						offset: receipt.deduplicated ? '-1' : offset,
						uid: receipt.uid as string,
						...(receipt.deduplicated ? { deduplicated: true as const } : {}),
					};
				});
		},

		async conversationSource(agentName, instanceId) {
			return (await opened(agentName, instanceId)).source;
		},

		async readAttachment(agentName, instanceId, attachmentId) {
			const instance = await opened(agentName, instanceId);
			return handleAgentAttachmentRead({
				source: instance.source,
				attachmentStore,
				streamPath: agentStreamPath(agentName, instanceId),
				attachmentId,
			});
		},

		instanceInfo(agentName, instanceId) {
			return instanceOf(agentName, instanceId).info();
		},

		async pendingQuestions(agentName, instanceId) {
			const instance = instanceOf(agentName, instanceId);
			if (!(await instance.info()).exists) return [];
			return (await opened(agentName, instanceId)).pendingQuestions();
		},

		async answerQuestion(agentName, instanceId, questionId, request) {
			const instance = instanceOf(agentName, instanceId);
			if (!(await instance.info()).exists) return { status: 'unknown' };
			return (await opened(agentName, instanceId)).answerQuestion(questionId, request.answer, {
				...(request.from ? { from: request.from } : {}),
				...(request.answerId ? { answerId: request.answerId } : {}),
			});
		},

		async waitForIdle() {
			// Settling one run can start another (a queued follow-up): settle until
			// a pass finds every instance idle.
			for (let pass = 0; pass < 1_000; pass++) {
				const all = [...instances.values()];
				await Promise.all(all.map((instance) => instance.waitForIdle(BACKGROUND_CONTEXT)));
				const idle = await Promise.all(all.map((instance) => instance.idle()));
				if (idle.every(Boolean) && all.length === instances.size) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},

		async shutdown(timeoutMs = 30_000) {
			stopping = true;
			activityGate?.pause();
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.all([...instances.values()].map((instance) => instance.waitForIdle())).catch(
					() => {},
				),
				new Promise<void>((resolve) => {
					timeout = setTimeout(resolve, timeoutMs);
					timeout.unref?.();
				}),
			]);
			if (timeout) clearTimeout(timeout);
			await Promise.allSettled([...instances.values()].map((instance) => instance.close()));
			instances.clear();
			await Promise.allSettled([...mcpCaches.values()].map((cache) => cache.close()));
			mcpCaches.clear();
		},
	};
}
