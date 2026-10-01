import { describe, expect, it } from 'vitest';
import { InMemoryConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { defineDurableStreamLogContractTests } from '../test-utils/define-durable-stream-log-contract-tests.ts';
import type { AppendOutcome } from './log.ts';
import { InMemoryDurableStreamLog } from './memory-log.ts';
import { STREAM_START } from './offset.ts';
import { conversationStreamStoreLog } from './store-bridge-log.ts';

defineDurableStreamLogContractTests('InMemoryDurableStreamLog', {
	create: () => new InMemoryDurableStreamLog(),
});

defineDurableStreamLogContractTests('conversationStreamStoreLog(InMemoryConversationStreamStore)', {
	create: () => conversationStreamStoreLog(new InMemoryConversationStreamStore()),
});

function appendedOffset(outcome: AppendOutcome): string {
	if (outcome.status !== 'appended') throw new Error(`expected appended, got ${outcome.status}`);
	return outcome.nextOffset;
}

describe('InMemoryDurableStreamLog', () => {
	it('mints the reference server offset shape', async () => {
		const log = new InMemoryDurableStreamLog();
		expect(await log.ensure('s')).toEqual({ nextOffset: '0000000000000000_0000000000000000' });
		const offset = appendedOffset(
			await log.append('s', { messages: [{ a: 1 }], producer: { id: 'p', epoch: 0, seq: 0 } }),
		);
		// 5-byte frame + `[{"a":1}]`.
		expect(offset).toBe(`0000000000000000_${String(5 + 9).padStart(16, '0')}`);
	});

	it('pages without splitting an append', async () => {
		const log = new InMemoryDurableStreamLog({ maxReadMessages: 2 });
		await log.ensure('s');
		const first = appendedOffset(
			await log.append('s', { messages: [1, 2, 3], producer: { id: 'p', epoch: 0, seq: 0 } }),
		);
		const second = appendedOffset(
			await log.append('s', { messages: [4], producer: { id: 'p', epoch: 0, seq: 1 } }),
		);
		const page = await log.read('s', STREAM_START);
		expect(page).toMatchObject({ messages: [1, 2, 3], nextOffset: first, upToDate: false });
		expect(await log.read('s', page.nextOffset)).toMatchObject({
			messages: [4],
			nextOffset: second,
			upToDate: true,
		});
	});

	it('returns an empty up-to-date batch at the tail when a long-poll times out', async () => {
		const log = new InMemoryDurableStreamLog({ longPollTimeoutMs: 20 });
		const { nextOffset } = await log.ensure('s');
		const batch = await log.read('s', nextOffset, { live: 'long-poll', cursor: '1' });
		expect(batch).toMatchObject({ messages: [], nextOffset, upToDate: true, closed: false });
		expect(Number(batch.cursor)).toBeGreaterThan(1);
	});

	it('does not wait when a long-poll is behind the tail', async () => {
		const log = new InMemoryDurableStreamLog({ longPollTimeoutMs: 60_000 });
		await log.ensure('s');
		// Reading an empty stream from -1 is not "caught up" by the reference
		// server's rule (only the exact tail offset, or `now`, waits).
		const batch = await log.read('s', STREAM_START, { live: 'long-poll' });
		expect(batch.messages).toEqual([]);
	});
});

describe('conversationStreamStoreLog', () => {
	it('re-derives the fences from the stream after a restart', async () => {
		const store = new InMemoryConversationStreamStore();
		const before = conversationStreamStoreLog(store);
		await before.ensure('s');
		appendedOffset(
			await before.append('s', {
				messages: ['a'],
				producer: { id: 'p', epoch: 2, seq: 0 },
				streamSeq: '0005',
			}),
		);
		appendedOffset(
			await before.append('s', { messages: ['b'], producer: { id: 'p', epoch: 2, seq: 1 } }),
		);

		const after = conversationStreamStoreLog(store);
		expect(
			(await after.append('s', { messages: ['b'], producer: { id: 'p', epoch: 2, seq: 1 } }))
				.status,
		).toBe('duplicate');
		expect(
			await after.append('s', { messages: ['z'], producer: { id: 'p', epoch: 1, seq: 0 } }),
		).toEqual({ status: 'fenced', currentEpoch: 2 });
		expect(
			(
				await after.append('s', {
					messages: ['z'],
					producer: { id: 'p', epoch: 3, seq: 0 },
					streamSeq: '0005',
				})
			).status,
		).toBe('stream-seq-conflict');
		expect((await after.read('s', STREAM_START)).messages).toEqual(['a', 'b']);
	});

	it('stays exactly-once when two bridges write one store', async () => {
		const store = new InMemoryConversationStreamStore();
		const left = conversationStreamStoreLog(store);
		const right = conversationStreamStoreLog(store);
		await left.ensure('s');
		const outcomes = await Promise.all(
			Array.from({ length: 6 }, (_, seq) =>
				(seq % 2 === 0 ? left : right).append('s', {
					messages: [seq],
					producer: { id: `w${seq}`, epoch: 0, seq: 0 },
				}),
			),
		);
		expect(outcomes.every((outcome) => outcome.status === 'appended')).toBe(true);
		// Retries through the other bridge are duplicates.
		const retries = await Promise.all(
			Array.from({ length: 6 }, (_, seq) =>
				(seq % 2 === 0 ? right : left).append('s', {
					messages: [seq],
					producer: { id: `w${seq}`, epoch: 0, seq: 0 },
				}),
			),
		);
		expect(retries.map((outcome) => outcome.status)).toEqual(Array(6).fill('duplicate'));
		expect([...((await left.read('s', STREAM_START)).messages as number[])].sort()).toEqual([
			0, 1, 2, 3, 4, 5,
		]);
	});

	it('refuses a stream that holds foreign records', async () => {
		const store = new InMemoryConversationStreamStore();
		await store.createStream('s', { agentName: 'durable-stream-log', instanceId: 's' });
		const producer = await store.acquireProducer('s', 'other');
		await store.append({
			path: 's',
			producerId: producer.producerId,
			producerEpoch: producer.producerEpoch,
			incarnation: producer.incarnation,
			producerSequence: 0,
			records: [
				{
					v: 1,
					id: 'r',
					type: 'user_message',
					conversationId: 'c',
					harness: 'default',
					session: 'default',
					timestamp: '2026-01-01T00:00:00.000Z',
					messageId: 'm',
					parentId: null,
					content: [],
				},
			],
		});
		const log = conversationStreamStoreLog(store);
		await expect(log.read('s', STREAM_START)).rejects.toMatchObject({ code: 'protocol' });
		await expect(
			log.append('s', { messages: [1], producer: { id: 'p', epoch: 0, seq: 0 } }),
		).rejects.toMatchObject({ code: 'protocol' });
	});
});
