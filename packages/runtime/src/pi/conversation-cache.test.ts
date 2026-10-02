/**
 * The conversation cache (`conversation-cache.ts`) over a bare Pi Harness on
 * Pi's SqliteStorage: it follows Pi's commits live, survives a cold start
 * with the same offsets, buffers streamed partials into pages, and rebuilds
 * from Pi reads — under a new identity — when it is missing or was left with
 * an open page.
 */
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	type Message,
} from '@earendil-works/pi-ai';
import { createRegistry, Harness, type ToolRegistration } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationStreamChunk } from '../conversation-public.ts';
import { context, removeTempFiles, tempFile, textOf } from '../entity/a2a-test-support.ts';
import { openNodeSqliteDatabase } from '../node/node-sqlite-database.ts';
import { PiConversationCache } from './conversation-cache.ts';

afterEach(async () => {
	await removeTempFiles();
});

async function open(file: string, options: { tokensPerSecond?: number } = {}) {
	const faux = fauxProvider({
		provider: 'cache',
		models: [{ id: 'm' }],
		...(options.tokensPerSecond
			? { tokensPerSecond: options.tokensPerSecond, tokenSize: { min: 4, max: 4 } }
			: {}),
	});
	faux.setResponses(
		Array.from({ length: 50 }, () => (request: { messages: Message[] }) => {
			const last = textOf(request.messages.findLast((message) => message.role === 'user'));
			return fauxAssistantMessage([
				fauxText(last.includes('long') ? 'abcd'.repeat(200) : `answer to ${last}`),
			]);
		}) as never,
	);
	const models = createModels();
	models.setProvider(faux.provider);
	const database = await openNodeSqliteDatabase(file);
	const storage = await SqliteStorage.open(database);
	const reports: unknown[] = [];
	const cache = new PiConversationCache({ database, onReport: (error) => reports.push(error) });
	const harness = await Harness.open(
		storage,
		{ models, registry: createRegistry<ToolRegistration>() },
		context,
	);
	await cache.attach(harness, storage, context);
	const root = await harness.root(context);
	if (!(await root.getModel(context)))
		await root.setModel({ provider: 'cache', modelId: 'm' }, context);
	let counter = 0;
	return {
		database,
		cache,
		harness,
		reports,
		async ask(content: string) {
			const submission = await root.submit(
				{ type: 'input', content, requestId: `q${Date.now()}-${counter++}` },
				context,
			);
			await submission.wait(context);
			await harness.waitForIdle(context);
		},
		async close() {
			cache.detach();
			await harness.close(context);
		},
	};
}

async function readAll(cache: PiConversationCache, from = '-1') {
	const chunks: ConversationStreamChunk[] = [];
	let offset = from;
	for (let page = 0; page < 100; page++) {
		const read = await cache.read(offset);
		if (read === 'aborted') throw new Error('aborted');
		chunks.push(...read.chunks);
		if (read.upToDate) return { chunks, offset: read.nextOffset };
		offset = read.nextOffset;
	}
	throw new Error('never up to date');
}

function texts(snapshot: { messages: { parts: { type: string; text?: string }[] }[] } | undefined) {
	return (snapshot?.messages ?? []).map((message) =>
		message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
	);
}

describe('PiConversationCache', () => {
	it('follows Pi live and serves the same history after a cold start', async () => {
		const file = await tempFile();
		const first = await open(file);
		await first.ask('one');
		await first.ask('two');
		const head = await first.cache.head();
		expect(texts(head.snapshot as never)).toEqual(['one', 'answer to one', 'two', 'answer to two']);
		const stream = await readAll(first.cache);
		expect(stream.offset).toBe(head.offset);
		expect(stream.chunks[0]?.type).toBe('conversation-reset');
		expect(stream.chunks.filter((chunk) => chunk.type === 'message-completed')).toHaveLength(2);
		expect(first.reports).toEqual([]);
		await first.close();

		// A cold start reads the checkpoint and the pages after it: same identity, same offsets.
		const second = await open(file);
		const cold = await second.cache.head();
		expect(cold.incarnation).toBe(head.incarnation);
		expect(cold.offset).toBe(head.offset);
		expect(cold.snapshot).toEqual(head.snapshot);
		expect(await readAll(second.cache)).toEqual(stream);
		// And it keeps following.
		await second.ask('three');
		expect(texts((await second.cache.head()).snapshot as never).at(-1)).toBe('answer to three');
		const after = await second.cache.read(head.offset);
		expect(
			after !== 'aborted' && after.chunks.some((chunk) => chunk.type === 'message-appended'),
		).toBe(true);
		await second.close();
	});

	it('buffers streamed partials and writes them a page at a time', async () => {
		const file = await tempFile();
		const opened = await open(file, { tokensPerSecond: 200 });
		const before = { ...opened.database.rows };
		await opened.ask('a long one');
		const written = opened.database.rows.rowsWritten - before.rowsWritten;
		const pages = opened.database
			.prepare('SELECT count(*) AS n FROM flue_conversation_log')
			.get<{ n: number }>();
		const stream = await readAll(opened.cache);
		const deltas = stream.chunks.filter((chunk) => chunk.type === 'message-delta').length;
		expect(deltas).toBeGreaterThan(1);
		// Every partial was its own row; far fewer pages were written.
		expect(Number(pages?.n)).toBeLessThan(deltas);
		expect(written).toBeGreaterThan(0);
		await opened.close();
	});

	it('rebuilds from Pi reads, under a new identity, when the cache is gone or a page was left open', async () => {
		const file = await tempFile();
		const first = await open(file);
		await first.ask('one');
		await first.ask('two');
		const live = await first.cache.head();
		await first.close();

		// Gone: as an instance written before the cache existed.
		const raw = await openNodeSqliteDatabase(file);
		await raw.exec('DROP TABLE flue_conversation_state');
		await raw.exec('DROP TABLE flue_conversation_log');
		await raw.close();
		const rebuilt = await open(file);
		const head = await rebuilt.cache.head();
		expect(head.incarnation).not.toBe(live.incarnation);
		expect(texts(head.snapshot as never)).toEqual(texts(live.snapshot as never));
		// A client holding an offset of the old identity re-hydrates.
		const resumed = await rebuilt.cache.read(live.offset);
		expect(resumed !== 'aborted' && resumed.chunks.map((chunk) => chunk.type)).toEqual([
			'conversation-reset',
		]);
		await rebuilt.close();

		// Left open: the object died mid-stream with partials only in memory.
		const crashed = await openNodeSqliteDatabase(file);
		await crashed.exec(
			"INSERT INTO flue_conversation_log (first_row, last_row, closed, page, folded) VALUES (1000000, 1000000, 0, '[]', '[]')",
		);
		await crashed.close();
		const recovered = await open(file);
		const after = await recovered.cache.head();
		expect(after.incarnation).not.toBe(head.incarnation);
		expect(texts(after.snapshot as never)).toEqual(texts(live.snapshot as never));
		await recovered.close();
	});
});
