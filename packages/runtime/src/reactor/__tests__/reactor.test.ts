import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '../../node/node-sqlite-database.ts';
import { InMemoryAttachmentStore } from '../../runtime/attachment-store.ts';
import { createMcpConnectionCache } from '../../mcp.ts';
import { InMemoryDurableStreamLog } from '../../streams/memory-log.ts';
import { eventsPath, inboxPath, questionsPath } from '../../entity/paths.ts';
import { STREAM_START } from '../../streams/offset.ts';
import { FlueAgentInstance } from '../../runtime/agent-instance.ts';
import { FlueReactorStore } from '../reactor-store.ts';
import { FlueReactor } from '../reactor.ts';
import { FlueReceiptIndex } from '../../pi/docs.ts';

describe('FlueReactor & Semantic Outbox Crash Boundaries', () => {
	const agentName = 'test-agent';
	const instanceId = 'inst-1';
	const entityRef = { type: agentName, id: instanceId };
	const eventStream = eventsPath(entityRef);

	async function setupEnvironment(options?: {
		dbPath?: string;
		streamLog?: InMemoryDurableStreamLog;
		now?: number;
	}) {
		const database = await openNodeSqliteDatabase(options?.dbPath ?? ':memory:');
		const streamLog = options?.streamLog ?? new InMemoryDurableStreamLog();
		await streamLog.ensure(eventStream);
		const armedWakes: { atMs: number; reason: unknown }[] = [];
		let currentTime = options?.now ?? 100_000;

		const createInstance = () =>
			new FlueAgentInstance({
				agentName,
				instanceId,
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async (atMs, reason) => {
					armedWakes.push({ atMs, reason });
				},
				now: () => currentTime,
				attachments: new InMemoryAttachmentStore(),
				entities: { log: streamLog },
			});

		const instance = createInstance();
		const store = new FlueReactorStore(database);

		return {
			database,
			streamLog,
			armedWakes,
			getTime: () => currentTime,
			setTime: (t: number) => {
				currentTime = t;
			},
			instance,
			createInstance,
			store,
		};
	}

	it('Boundary 1: Pi settled -> [CRASH] -> restart converges with 1 event and no lost obligation', async () => {
		const env = await setupEnvironment();
		const host = await env.instance.host();

		// Admit task-1
		await env.instance.admit({
			kind: 'direct',
			submissionId: 'task-1',
			message: { kind: 'signal', type: 'test', body: '' },
			acceptedAt: new Date(env.getTime()).toISOString(),
		});

		// Mock Pi settlement
		const mockSettlement = {
			submissionId: 'task-1',
			outcome: 'completed' as const,
			result: { resultType: 'complete', content: [{ type: 'text', text: 'result 1' }] },
			settledAt: new Date(env.getTime()).toISOString(),
		};
		vi.spyOn(host, 'settlement').mockResolvedValue(mockSettlement);

		// State: task-1 is in index.live; flue_outbox is empty; Electric has 0 messages
		const indexBefore = await host.harness.snapshot(FlueReceiptIndex, BACKGROUND_CONTEXT);
		expect(indexBefore?.live?.['task-1']).toBeDefined();
		expect(env.store.outboxCount()).toBe(0);
		const initialBatch = await env.streamLog.read(eventStream, STREAM_START);
		expect(initialBatch.messages.length).toBe(0);

		// [RESTART]: A new instance / alarm wake triggers reactor.tick()
		const restarted = env.createInstance();
		const restartedHost = await restarted.host();
		vi.spyOn(restartedHost, 'settlement').mockResolvedValue(mockSettlement);
		vi.spyOn(restarted, 'settlement').mockResolvedValue(mockSettlement);

		const tickResult = await restarted.wake();
		expect(tickResult.behind).toBe(false);

		// Verification:
		// 1. Exactly 1 event appended to Electric
		const batch = await env.streamLog.read(eventStream, STREAM_START);
		expect(batch.messages.length).toBe(1);
		const msg = batch.messages[0] as { id: string; name: string; data: Record<string, unknown> };
		expect(msg.id).toBe('task-settled:task-1');
		expect(msg.name).toBe('task.completed');
		expect(msg.data.taskId).toBe('task-1');

		// 2. Outbox is completely empty (no lingering obligations)
		expect(env.store.outboxCount()).toBe(0);

		// 3. Receipt is retired from index.live
		const indexAfter = await restartedHost.harness.snapshot(FlueReceiptIndex, BACKGROUND_CONTEXT);
		expect(indexAfter?.live?.['task-1']).toBeUndefined();
	});

	it('Boundary 2: outbox INSERT -> [CRASH] -> restart converges with idempotent INSERT OR IGNORE', async () => {
		const env = await setupEnvironment();
		const host = await env.instance.host();

		// Admit task-2
		await env.instance.admit({
			kind: 'direct',
			submissionId: 'task-2',
			message: { kind: 'signal', type: 'test', body: '' },
			acceptedAt: new Date(env.getTime()).toISOString(),
		});

		const mockSettlement = {
			submissionId: 'task-2',
			outcome: 'completed' as const,
			result: { resultType: 'complete', content: [{ type: 'text', text: 'result 2' }] },
			settledAt: new Date(env.getTime()).toISOString(),
		};
		vi.spyOn(host, 'settlement').mockResolvedValue(mockSettlement);

		// Simulate Step 3a: Outbox INSERT commits FIRST
		env.store.enqueue({
			id: 'task-settled:task-2',
			stream: eventStream,
			event: { id: 'task-settled:task-2', name: 'task.completed', data: { taskId: 'task-2' } },
		});
		expect(env.store.outboxCount()).toBe(1);

		// [CRASH SIMULATION]: Process dies before Step 3b (retireSettledReceipts)
		// State: task-2 is STILL in index.live; outbox has obligation; Electric has 0 messages
		const liveCheck = await host.harness.snapshot(FlueReceiptIndex, BACKGROUND_CONTEXT);
		expect(liveCheck?.live?.['task-2']).toBeDefined();

		// [RESTART]: Next wake runs reconcileSettlements
		const restarted = env.createInstance();
		const restartedHost = await restarted.host();
		vi.spyOn(restartedHost, 'settlement').mockResolvedValue(mockSettlement);

		await restarted.wake();

		// Verification:
		// 1. Exactly 1 event appended to Electric
		const batch = await env.streamLog.read(eventStream, STREAM_START);
		expect(batch.messages.length).toBe(1);
		expect((batch.messages[0] as any).id).toBe('task-settled:task-2');

		// 2. Outbox is cleared
		expect(env.store.outboxCount()).toBe(0);

		// 3. Receipt is retired from index.live
		const indexAfter = await restartedHost.harness.snapshot(FlueReceiptIndex, BACKGROUND_CONTEXT);
		expect(indexAfter?.live?.['task-2']).toBeUndefined();
	});

	it('Boundary 3: Pi live retirement -> [CRASH] -> restart delivers durable outbox obligation', async () => {
		const env = await setupEnvironment();
		const host = await env.instance.host();

		// Admit task-3
		await env.instance.admit({
			kind: 'direct',
			submissionId: 'task-3',
			message: { kind: 'signal', type: 'test', body: '' },
			acceptedAt: new Date(env.getTime()).toISOString(),
		});

		// Simulate Step 3a: Outbox INSERT
		env.store.enqueue({
			id: 'task-settled:task-3',
			stream: eventStream,
			event: { id: 'task-settled:task-3', name: 'task.completed', data: { taskId: 'task-3' } },
		});

		// Simulate Step 3b: Retire from index.live
		await host.harness.commit(async (tx) => {
			const index = await tx.doc(FlueReceiptIndex);
			delete index.live['task-3'];
		}, BACKGROUND_CONTEXT);

		// [CRASH SIMULATION]: Process dies before Step 4 (flushOutbox)
		// State: task-3 is GONE from index.live; row is in flue_outbox; Electric has 0 messages
		expect(env.store.outboxCount()).toBe(1);

		// [RESTART]: Wake runs
		const restarted = env.createInstance();
		await restarted.wake();

		// Verification:
		// Outbox delivered the event despite Pi live index having already forgotten task-3!
		const batch = await env.streamLog.read(eventStream, STREAM_START);
		expect(batch.messages.length).toBe(1);
		expect((batch.messages[0] as any).id).toBe('task-settled:task-3');
		expect(env.store.outboxCount()).toBe(0);
	});

	it('Boundary 4: Electric append -> [CRASH] -> restart converges with bounded duplicate append with same deterministic ID', async () => {
		const env = await setupEnvironment();

		// Enqueue task-4 into outbox
		const domainEvent = {
			id: 'task-settled:task-4',
			name: 'task.completed',
			data: { taskId: 'task-4' },
		};
		env.store.enqueue({
			id: 'task-settled:task-4',
			stream: eventStream,
			event: domainEvent,
		});

		// Simulate Electric append succeeded
		await env.streamLog.append(eventStream, [domainEvent]);

		// [CRASH SIMULATION]: Process dies BEFORE `DELETE FROM flue_outbox`
		// State: Electric has 1 message; outbox STILL has 1 row
		expect(env.store.outboxCount()).toBe(1);
		const initialBatch = await env.streamLog.read(eventStream, STREAM_START);
		expect(initialBatch.messages.length).toBe(1);

		// [RESTART]: Wake runs flushOutbox again
		const restarted = env.createInstance();
		await restarted.wake();

		// Verification:
		// 1. Both physical appends carried the EXACT same deterministic ID
		const batch = await env.streamLog.read(eventStream, STREAM_START);
		expect(batch.messages.length).toBe(2);
		expect((batch.messages[0] as any).id).toBe('task-settled:task-4');
		expect((batch.messages[1] as any).id).toBe('task-settled:task-4');

		// 2. Outbox is now empty
		expect(env.store.outboxCount()).toBe(0);
	});

	it('Boundary 5: Electric failure / retry backoff -> heals and delivers without stuck alarms', async () => {
		const env = await setupEnvironment();
		const host = await env.instance.host();

		// Mock Electric failure
		let electricDown = true;
		const originalAppend = env.streamLog.append.bind(env.streamLog);
		vi.spyOn(env.streamLog, 'append').mockImplementation(
			async (path: string, messages: readonly unknown[]) => {
				if (electricDown) {
					throw new Error('Electric 503 Service Unavailable');
				}
				return originalAppend(path, messages);
			},
		);

		// Admit task-5
		await env.instance.admit({
			kind: 'direct',
			submissionId: 'task-5',
			message: { kind: 'signal', type: 'test', body: '' },
			acceptedAt: new Date(env.getTime()).toISOString(),
		});

		const mockSettlement = {
			submissionId: 'task-5',
			outcome: 'completed' as const,
			result: { resultType: 'complete', content: [{ type: 'text', text: 'result 5' }] },
			settledAt: new Date(env.getTime()).toISOString(),
		};
		vi.spyOn(host, 'settlement').mockResolvedValue(mockSettlement);

		// Wake runs while Electric is down
		await env.instance.wake();

		// Verification after failure:
		// 1. Outbox entry remains, attempts = 1, retry_at = now + 5000
		const entry = env.store.getOutboxEntry('task-settled:task-5');
		expect(entry).toBeDefined();
		expect(entry?.attempts).toBe(1);
		expect(entry?.retryAt).toBe(env.getTime() + 5000);

		// 2. Alarm was armed for retry_at
		const retryWake = env.armedWakes.find((w) => w.atMs === env.getTime() + 5000);
		expect(retryWake).toBeDefined();

		// Electric heals!
		electricDown = false;
		env.setTime(env.getTime() + 5000);

		// Next alarm wake executes
		await env.instance.wake();

		// Verification after healing:
		// 1. Event delivered to Electric
		const batch = await env.streamLog.read(eventStream, STREAM_START);
		expect(batch.messages.length).toBe(1);
		expect((batch.messages[0] as any).id).toBe('task-settled:task-5');

		// 2. Outbox is completely clear
		expect(env.store.outboxCount()).toBe(0);
	});

	it('Semantic Emitter: unifies A2A messaging and questions through durable outbox', async () => {
		const env = await setupEnvironment();
		const reactor = env.instance.reactor;

		// 1. Emit A2A message
		const targetInbox = inboxPath({ type: 'target-agent', id: '2' });
		await env.streamLog.ensure(targetInbox);
		await reactor.emitSemantic({
			id: 'a2a-msg-1',
			stream: targetInbox,
			event: { type: 'flue.a2a.message', messageId: 'a2a-msg-1', text: 'hello' },
		});

		// Assert delivered to Electric and cleared from outbox
		const a2aBatch = await env.streamLog.read(targetInbox, STREAM_START);
		expect(a2aBatch.messages.length).toBe(1);
		expect(env.store.outboxCount()).toBe(0);

		// 2. Emit Question
		const qPath = questionsPath(entityRef);
		await env.streamLog.ensure(qPath);
		await reactor.emitSemantic({
			id: 'q-req-1',
			stream: qPath,
			event: { type: 'flue.input-requested', questionId: 'q-1', summary: 'Approve?' },
		});

		// Assert delivered to Electric and cleared from outbox
		const qBatch = await env.streamLog.read(qPath, STREAM_START);
		expect(qBatch.messages.length).toBe(1);
		expect(env.store.outboxCount()).toBe(0);
	});
});
