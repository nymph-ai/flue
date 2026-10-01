import { describe, expect, it } from 'vitest';
import { InMemoryConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { defineDurableStreamLogContractTests } from '../test-utils/define-durable-stream-log-contract-tests.ts';
import { InMemoryDurableStreamLog } from './memory-log.ts';
import { STREAM_START } from './offset.ts';
import { conversationStreamStoreLog } from './store-bridge-log.ts';

defineDurableStreamLogContractTests('InMemoryDurableStreamLog', {
	create: () => new InMemoryDurableStreamLog(),
});

defineDurableStreamLogContractTests('conversationStreamStoreLog(InMemoryConversationStreamStore)', {
	create: () => conversationStreamStoreLog(new InMemoryConversationStreamStore()),
});

describe('InMemoryDurableStreamLog', () => {
	it('mints the reference server offset shape', async () => {
		const log = new InMemoryDurableStreamLog();
		expect(await log.ensure('s')).toEqual({ nextOffset: '0000000000000000_0000000000000000' });
		const { nextOffset } = await log.append('s', [{ a: 1 }]);
		// 5-byte frame + `[{"a":1}]`.
		expect(nextOffset).toBe(`0000000000000000_${String(5 + 9).padStart(16, '0')}`);
	});

	it('pages without splitting an append', async () => {
		const log = new InMemoryDurableStreamLog({ maxReadMessages: 2 });
		await log.ensure('s');
		const first = (await log.append('s', [1, 2, 3])).nextOffset;
		const second = (await log.append('s', [4])).nextOffset;
		const page = await log.read('s', STREAM_START);
		expect(page).toMatchObject({ messages: [1, 2, 3], nextOffset: first, upToDate: false });
		expect(await log.read('s', page.nextOffset)).toMatchObject({
			messages: [4],
			nextOffset: second,
			upToDate: true,
		});
	});

	it('tells append observers the path and the new tail', async () => {
		const log = new InMemoryDurableStreamLog();
		await log.ensure('s');
		const seen: string[] = [];
		const stop = log.onAppend((path, offset) => seen.push(`${path}@${offset}`));
		const { nextOffset } = await log.append('s', ['x']);
		stop();
		await log.append('s', ['y']);
		expect(seen).toEqual([`s@${nextOffset}`]);
	});
});

describe('conversationStreamStoreLog', () => {
	it('keeps appending when two bridges write one store', async () => {
		const store = new InMemoryConversationStreamStore();
		const a = conversationStreamStoreLog(store);
		const b = conversationStreamStoreLog(store);
		await a.ensure('s');
		await Promise.all(Array.from({ length: 6 }, (_, n) => (n % 2 === 0 ? a : b).append('s', [n])));
		const all = await a.read('s', STREAM_START);
		expect([...(all.messages as number[])].sort()).toEqual([0, 1, 2, 3, 4, 5]);
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
	});
});
