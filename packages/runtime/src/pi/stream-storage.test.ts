import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import { A2A_SEND_ENTRY_KIND, PUBLISH_ENTRY_KIND } from './a2a-entries.ts';
import {
	context,
	defineStreamStorageCrashTests,
	ENTITY,
	FaultyLog,
	loggedEnvelopes,
	openStreamStorage,
	removeTempFiles,
	runHarnessSession,
	snapshotReads,
	tempFile,
} from './stream-storage-test-support.ts';
import type { StreamStorage } from './stream-storage.ts';

for (const publish of ['async', 'await'] as const) {
	registerStorageConformance(
		{ describe, expect, it },
		`StreamStorage (node:sqlite + InMemoryDurableStreamLog, publish: ${publish})`,
		async (use) => {
			const log = new InMemoryDurableStreamLog();
			const { storage, fences } = await openStreamStorage({ file: await tempFile(), log, publish });
			try {
				await use(storage);
			} finally {
				await storage.close(context).catch(() => {});
				await removeTempFiles();
			}
			expect(fences).toEqual([]);
		},
	);
}

defineStreamStorageCrashTests('StreamStorage crash matrix (InMemoryDurableStreamLog)', {
	log: () => new InMemoryDurableStreamLog(),
	pathPrefix: 'flue/v1/crash/',
});

describe('StreamStorage', () => {
	const opened: StreamStorage[] = [];
	afterEach(async () => {
		for (const storage of opened) await storage.close(context).catch(() => {});
		opened.length = 0;
		await removeTempFiles();
	});

	async function open(options: Parameters<typeof openStreamStorage>[0]) {
		const result = await openStreamStorage(options);
		opened.push(result.storage);
		return result;
	}

	async function lastSeq(storage: StreamStorage): Promise<number> {
		return (storage as unknown as { lastIndexedSeq(): number }).lastIndexedSeq();
	}

	it('rebuilds every Pi read of a real Harness session identically', async () => {
		const log = new InMemoryDurableStreamLog();
		const file = await tempFile();
		// Tiny messages force multi-part envelopes through the log.
		const first = await open({ file, log, maxMessageBytes: 2048 });
		await runHarnessSession(first.storage); // closes the storage with the Harness
		const reopened = await open({ file, log, maxMessageBytes: 2048 });
		await reopened.storage.drain();
		const seqs = await lastSeq(reopened.storage);
		expect(seqs).toBeGreaterThan(10);
		const before = await snapshotReads(reopened.storage, seqs);

		const envelopes = await loggedEnvelopes(log, reopened.storage.path);
		expect(envelopes.map((envelope) => envelope.seq)).toEqual(Array.from({ length: seqs }, (_, i) => i + 1));
		expect(new Set(envelopes.map((envelope) => envelope.storage))).toEqual(
			new Set([reopened.storage.incarnation]),
		);

		// Drop the index and replay the log in place.
		await reopened.storage.rebuild(context);
		expect(await snapshotReads(reopened.storage, seqs)).toEqual(before);

		// A brand-new database over the same log.
		const fresh = await open({ file: await tempFile(), log });
		expect(await snapshotReads(fresh.storage, seqs)).toEqual(before);
		expect(fresh.fences).toEqual([]);
	});

	it('publishes every commit in order and records offsets (async mode)', async () => {
		const log = new InMemoryDurableStreamLog();
		const { storage, reports } = await open({ file: await tempFile(), log });
		for (let index = 0; index < 5; index++) await storage.commit([], context);
		await storage.drain();
		expect(storage.outbox.pending()).toBe(0);
		const through = storage.outbox.publishedThrough();
		expect(through?.seq).toBe(5);
		expect(through?.nextOffset).toBe((await log.head(storage.path))?.nextOffset);
		expect((await loggedEnvelopes(log, storage.path)).map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(reports).toEqual([]);
	});

	it('never fails a commit on a publish failure, and arms a wake for the retry', async () => {
		const inner = new InMemoryDurableStreamLog();
		const log = new FaultyLog(inner);
		log.block();
		const wakes: number[] = [];
		const { storage } = await open({
			file: await tempFile(),
			log,
			publish: 'await',
			publishTimeoutMs: 50,
			armWake: (at) => {
				wakes.push(at);
			},
			backoff: { initialMs: 5, maxMs: 5 },
		});
		expect(await storage.commit([], context)).toBe(1);
		expect(await storage.commit([], context)).toBe(2);
		expect(storage.outbox.pending()).toBe(2);
		expect(wakes.length).toBeGreaterThan(0);
		log.revive();
		expect(await storage.drain()).toEqual({ status: 'published' });
		expect((await loggedEnvelopes(inner, storage.path)).map((envelope) => envelope.seq)).toEqual([1, 2]);
	});

	it('writes relay rows for A2A sends and publishes in the commit transaction', async () => {
		const log = new InMemoryDurableStreamLog();
		const { storage } = await open({ file: await tempFile(), log });
		await storage.commit([{ type: 'conversation', value: { id: 1 } }] as never, context);
		const entry = (id: number, kind: string, data: unknown) => ({
			type: 'entry',
			value: { id, conversationId: 1, kind, data },
		});
		const seq = await storage.commit(
			[
				entry(10, A2A_SEND_ENTRY_KIND, {
					target: { type: 'reviewer', id: 'bob' },
					messageId: 'm-1',
					message: { text: 'hi' },
				}),
				entry(11, A2A_SEND_ENTRY_KIND, { target: { type: 'reviewer', id: 'bob' }, messageId: 'm-2', message: {} }),
				entry(12, PUBLISH_ENTRY_KIND, { eventId: 'e-1', event: { ok: true } }),
				entry(13, 'flue.data', { unrelated: true }),
			] as never,
			context,
		);
		expect(storage.outbox.relayRows()).toEqual([
			{
				seq,
				target: 'flue/v1/reviewer/bob/inbox',
				producerId: `${ENTITY.type}/${ENTITY.id}->inbox`,
				producerEpoch: 0,
				producerSeq: 0,
				body: { type: 'flue.a2a.message', from: ENTITY, messageId: 'm-1', message: { text: 'hi' } },
			},
			{
				seq,
				target: 'flue/v1/reviewer/bob/inbox',
				producerId: `${ENTITY.type}/${ENTITY.id}->inbox`,
				producerEpoch: 0,
				producerSeq: 1,
				body: { type: 'flue.a2a.message', from: ENTITY, messageId: 'm-2', message: {} },
			},
			{
				seq,
				target: `flue/v1/${ENTITY.type}/${ENTITY.id}/events`,
				producerId: `${ENTITY.type}/${ENTITY.id}->events`,
				producerEpoch: 0,
				producerSeq: 0,
				body: { type: 'flue.event', from: ENTITY, eventId: 'e-1', event: { ok: true } },
			},
		]);
		// A malformed relay entry rolls the whole commit back.
		await expect(
			storage.commit([entry(20, A2A_SEND_ENTRY_KIND, { target: 'nobody' })] as never, context),
		).rejects.toThrow(/Malformed flue.a2a.send/);
		expect(await storage.entry(20 as never, context)).toBeUndefined();
		expect(storage.outbox.relayRows()).toHaveLength(3);
	});

	it('names the log flue/v1/{agent}/{instance}/pi', async () => {
		const log = new InMemoryDurableStreamLog();
		const { storage } = await open({ log, entity: { type: 'support agent', id: 'a/b' } });
		expect(storage.path).toBe('flue/v1/support%20agent/a%2Fb/pi');
		expect(storage.producerId).toBe('support%20agent/a%2Fb/pi');
	});
});
