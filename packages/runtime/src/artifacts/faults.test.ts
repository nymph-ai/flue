/**
 * Local fault injection (P22-A13).
 *
 * Crash-before-append leaves the outbox obligation. Crash-after-append
 * before delete is a duplicate the reducer ignores. A skipped producer seq
 * sets gap. Revoke blocks the action gate. None of this talks to Electric.
 */
import { describe, expect, it } from 'vitest';
import { doSqliteDatabase } from '../cloudflare/do-sqlite-database.ts';
import { FakeDurableObjectStorage } from '../cloudflare/do-sqlite-test-support.ts';
import { appendCreatingMany } from '../entity/append.ts';
import { FlueReactorStore } from '../reactor/reactor-store.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import { authorizeArtifactAction } from './actions/authorize.ts';
import { createFence, stampEvent } from './publish/fence.ts';
import { emptySnapshot, reduceArtifactEvents } from './read-model/reducer.ts';

const ARTIFACT = 'artifact://tenant-alpha/scoreboard';
const STREAM = 'flue/v1/artifact/tenant-alpha/scoreboard/events';

describe('artifact fault injection', () => {
	it('keeps the outbox row when the process dies before append', () => {
		const store = new FlueReactorStore(doSqliteDatabase(new FakeDurableObjectStorage()));
		store.enqueue({
			id: 'evt-crash',
			stream: STREAM,
			event: { eventId: 'evt-crash', type: 'artifact.state.updated' },
		});
		expect(store.pendingEvents(Date.now()).map((row) => row.eventId)).toEqual(['evt-crash']);
	});

	it('dedupes an event that was appended and then replayed after a crash', async () => {
		const log = new InMemoryDurableStreamLog();
		const fence = createFence('agentdo:score', 1);
		const event = stampEvent(fence, {
			eventId: 'evt-1',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: '2026-10-12T00:00:00.000Z',
			semanticRevision: 1,
			payload: { patch: { home: 4 } },
		});
		await appendCreatingMany(log, STREAM, [event], undefined);
		const once = reduceArtifactEvents(emptySnapshot(ARTIFACT, 't'), [event], { cursor: 'c', now: 't' });
		const replayed = reduceArtifactEvents(once.snapshot, [event], { cursor: 'c', now: 't2' });
		expect(replayed.duplicates).toBe(1);
		expect(replayed.applied).toBe(0);
		expect(replayed.snapshot.state.home).toBe(4);
	});

	it('flags a producer sequence gap', () => {
		const fence = createFence('agentdo:score', 1);
		const first = stampEvent(fence, {
			eventId: 'evt-1',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: 't',
			semanticRevision: 1,
			payload: { patch: { home: 1 } },
		});
		const jumped = {
			...stampEvent(fence, {
				eventId: 'evt-3',
				streamId: STREAM,
				type: 'artifact.state.updated',
				artifactId: ARTIFACT,
				occurredAt: 't',
				semanticRevision: 3,
				payload: { patch: { home: 3 } },
			}),
			producerSeq: 3,
		};
		const reduced = reduceArtifactEvents(emptySnapshot(ARTIFACT, 't'), [first, jumped], {
			cursor: 'c',
			now: 't',
		});
		expect(reduced.gap).toBe(true);
	});

	it('blocks actions after revoke', () => {
		const decision = authorizeArtifactAction({
			claims: {
				artifactId: ARTIFACT,
				tenantId: 'tenant-alpha',
				principal: 'user:alice',
				tools: ['artifact.score.increment'],
				exp: 9,
			},
			artifactId: ARTIFACT,
			tenantId: 'tenant-alpha',
			toolName: 'artifact.score.increment',
			appOnlyTools: [],
			allowedTools: ['artifact.score.increment'],
			revoked: true,
			requiresFabricAdmission: false,
			fabricAdmitted: false,
		});
		expect(decision).toMatchObject({ allowed: false, code: 'REVOKED' });
	});
});
