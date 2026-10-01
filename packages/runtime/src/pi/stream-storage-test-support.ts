/**
 * Test support for `StreamStorage`: a genuine Pi Harness session to record
 * real `StorageWrite` batches, a snapshot of every Pi read API, fault-injecting
 * logs and databases, and the crash/replay suite that runs against both the
 * in-memory log and a real Durable Streams server.
 *
 * Imported only by `*.test.ts`; never part of a build entry.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	Type,
} from '@earendil-works/pi-ai';
import {
	type Conversation,
	ConversationConfig,
	type Cursor,
	createRegistry,
	defineDoc,
	Harness,
	MemoryStorage,
	type Seq,
	type Storage,
	type StorageWrite,
} from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppendOutcome, DurableStreamLog, ProducerClaim, ReadBatch } from '../streams/log.ts';
import { STREAM_START, type StreamOffset } from '../streams/offset.ts';
import { A2A_SEND_ENTRY_KIND, type EntityAddress, PUBLISH_ENTRY_KIND } from './a2a-entries.ts';
import { CommitAssembler, type PiCommitEnvelope } from './commit-envelope.ts';
import type { FenceReason } from './commit-outbox.ts';
import { StreamStorage, type StreamStorageOptions } from './stream-storage.ts';

export const context: Context = BACKGROUND_CONTEXT;

// ─── Temp files ─────────────────────────────────────────────────────────────

const directories = new Set<string>();

export async function tempFile(name = 'pi.sqlite'): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'flue-stream-storage-'));
	directories.add(directory);
	return join(directory, name);
}

export async function removeTempFiles(): Promise<void> {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
}

// ─── Opening storages ───────────────────────────────────────────────────────

export const ENTITY: EntityAddress = { type: 'assistant', id: 'inst-1' };

export interface OpenedStorage {
	readonly storage: StreamStorage;
	readonly fences: { readonly epoch: number; readonly reason: FenceReason }[];
	readonly reports: unknown[];
}

export async function openStreamStorage(
	options: {
		readonly file?: string;
		readonly database?: SqliteDatabase;
		readonly log: DurableStreamLog;
		readonly entity?: EntityAddress;
		readonly path?: string;
	} & Partial<
		Omit<StreamStorageOptions, 'database' | 'log' | 'entity' | 'onFenced' | 'onReport' | 'path'>
	>,
): Promise<OpenedStorage> {
	const fences: { epoch: number; reason: FenceReason }[] = [];
	const reports: unknown[] = [];
	const { file, database, log, entity, ...rest } = options;
	const db = database ?? (await openNodeSqliteDatabase(file ?? ':memory:'));
	const storage = await StreamStorage.open(
		{
			// Retries in these tests are driven explicitly with drain().
			backoff: { initialMs: 60_000, maxMs: 60_000 },
			// These suites are about the Pi log; the relay has its own (entity/*.test.ts).
			relay: false,
			...rest,
			database: db,
			log,
			entity: entity ?? ENTITY,
			onFenced: (epoch, reason) => fences.push({ epoch, reason }),
			onReport: (error) => reports.push(error),
		},
		context,
	);
	return { storage, fences, reports };
}

// ─── Reading the log ────────────────────────────────────────────────────────

/** Every envelope on the log, reassembled, in order. */
export async function loggedEnvelopes(
	log: DurableStreamLog,
	path: string,
): Promise<PiCommitEnvelope[]> {
	const envelopes: PiCommitEnvelope[] = [];
	const assembler = new CommitAssembler();
	let offset: StreamOffset = STREAM_START;
	while (true) {
		const batch = await log.read(path, offset);
		for (const message of batch.messages) {
			const envelope = assembler.accept(message);
			if (envelope) envelopes.push(envelope);
		}
		offset = batch.nextOffset;
		if (batch.upToDate || batch.messages.length === 0) return envelopes;
	}
}

// ─── Fault injection ────────────────────────────────────────────────────────

export class CrashError extends Error {
	constructor(message = 'injected crash') {
		super(message);
		this.name = 'CrashError';
	}
}

/**
 * A log that can crash an append at a chosen point:
 * - `before-append`: the POST never leaves.
 * - `drop-ack`: the POST lands, the caller never learns it.
 * After either, the log is dead (every call throws) until `revive()`.
 * `block()` makes appends fail without crashing (a network outage).
 */
export class FaultyLog implements DurableStreamLog {
	readonly inner: DurableStreamLog;
	readonly appends: {
		readonly producer: ProducerClaim;
		readonly streamSeq?: string;
		outcome?: string;
	}[] = [];
	private next: 'before-append' | 'drop-ack' | undefined;
	private dead = false;
	private blocked = false;

	constructor(inner: DurableStreamLog) {
		this.inner = inner;
	}

	crashNextAppend(point: 'before-append' | 'drop-ack'): void {
		this.next = point;
	}

	block(): void {
		this.blocked = true;
	}

	revive(): void {
		this.dead = false;
		this.blocked = false;
		this.next = undefined;
	}

	ensure(path: string, signal?: AbortSignal): Promise<{ readonly nextOffset: StreamOffset }> {
		this.assertAlive();
		return this.inner.ensure(path, signal);
	}

	async append(
		path: string,
		input: {
			readonly messages: readonly unknown[];
			readonly producer: ProducerClaim;
			readonly streamSeq?: string;
		},
		signal?: AbortSignal,
	): Promise<AppendOutcome> {
		this.assertAlive();
		const record: { producer: ProducerClaim; streamSeq?: string; outcome?: string } = {
			producer: input.producer,
			...(input.streamSeq === undefined ? {} : { streamSeq: input.streamSeq }),
		};
		this.appends.push(record);
		if (this.blocked) {
			record.outcome = 'blocked';
			return { status: 'retryable', error: new Error('blocked') };
		}
		const point = this.next;
		this.next = undefined;
		if (point === 'before-append') {
			this.dead = true;
			record.outcome = 'crash-before';
			throw new CrashError('crash before the POST');
		}
		const outcome = await this.inner.append(path, input, signal);
		record.outcome = outcome.status;
		if (point === 'drop-ack') {
			this.dead = true;
			throw new CrashError('crash after the append, before the ack');
		}
		return outcome;
	}

	read(
		path: string,
		from: StreamOffset,
		options?: {
			readonly live?: false | 'long-poll' | 'sse';
			readonly cursor?: string;
			readonly signal?: AbortSignal;
		},
	): Promise<ReadBatch> {
		this.assertAlive();
		return this.inner.read(path, from, options);
	}

	head(path: string, signal?: AbortSignal) {
		this.assertAlive();
		return this.inner.head(path, signal);
	}

	private assertAlive(): void {
		if (this.dead) throw new CrashError('the process is dead');
	}
}

/** A database whose next transaction dies before it begins. */
export class FaultyDatabase implements SqliteDatabase {
	readonly inner: SqliteDatabase;
	failNextTransaction = false;

	constructor(inner: SqliteDatabase) {
		this.inner = inner;
	}

	exec(sql: string): void {
		this.inner.exec(sql);
	}

	prepare(sql: string) {
		return this.inner.prepare(sql);
	}

	transaction<T>(callback: () => T): T | Promise<T> {
		if (this.failNextTransaction) {
			this.failNextTransaction = false;
			throw new CrashError('crash before the local transaction');
		}
		return this.inner.transaction(callback);
	}

	close(): void | Promise<void> {
		return this.inner.close();
	}
}

// ─── A genuine Pi session ───────────────────────────────────────────────────

export const Notes = defineDoc<{ text: string; revisions: number }>({
	kind: 'flue.test.notes',
	version: 1,
	scope: 'conversation',
	history: 'rewindable',
	fork: 'asOf',
	initial: () => ({ text: '', revisions: 0 }),
});

/**
 * Drive a real Pi Harness with pi-ai's faux provider over `storage`: a tool
 * round, a streamed answer (live-doc deltas), a rewindable document edited
 * twice, relay entries through write submissions, a reset, and a final turn.
 */
export async function runHarnessSession(storage: Storage): Promise<void> {
	const faux = fauxProvider({ tokensPerSecond: 4000, tokenSize: { min: 3, max: 5 } });
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.tools.add({
		name: 'echo',
		description: 'Echo the text',
		parameters: Type.Object({ text: Type.String() }),
		execute: async (args) => ({
			content: [{ type: 'text', text: `echo ${(args as { text: string }).text}` }],
		}),
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('echo', { text: 'hello' }, { id: 'call-1' })], {
			stopReason: 'toolUse',
		}),
		fauxAssistantMessage([fauxText(`The echo said hello. ${'Streaming text. '.repeat(40)}`)]),
		fauxAssistantMessage('Second answer.'),
		fauxAssistantMessage('After the reset.'),
	]);
	const harness = await Harness.open(storage, { models, registry }, context);
	try {
		const root: Conversation = await harness.root(context, {
			init: async (tx, id) => {
				(await tx.doc(ConversationConfig, id)).model = { provider: 'faux', modelId: 'faux-1' };
			},
		});
		harness.resume();
		const first = await root.submit(
			{ type: 'input', content: 'say hello', requestId: 'req-1' },
			context,
		);
		expect((await first.wait(context)).status).toBe('done');
		await root.commit(async (tx) => {
			const notes = await tx.doc(Notes, root.id);
			notes.text = 'first note';
			notes.revisions += 1;
		}, context);
		const second = await root.submit(
			{ type: 'input', content: 'again', requestId: 'req-2' },
			context,
		);
		expect((await second.wait(context)).status).toBe('done');
		await root.commit(async (tx) => {
			const notes = await tx.doc(Notes, root.id);
			notes.text += ', second note';
			notes.revisions += 1;
		}, context);
		await (
			await root.submit(
				{
					type: 'write',
					requestId: 'send-1',
					entry: {
						kind: A2A_SEND_ENTRY_KIND,
						data: {
							target: { type: 'reviewer', id: 'bob' },
							messageId: 'msg-1',
							message: { text: 'hi bob' },
						},
					},
				},
				context,
			)
		).wait(context);
		await (
			await root.submit(
				{
					type: 'write',
					requestId: 'publish-1',
					entry: { kind: PUBLISH_ENTRY_KIND, data: { eventId: 'evt-1', event: { status: 'ok' } } },
				},
				context,
			)
		).wait(context);
		await root.reset(undefined, context);
		const third = await root.submit(
			{ type: 'input', content: 'after reset', requestId: 'req-3' },
			context,
		);
		expect((await third.wait(context)).status).toBe('done');
		await harness.waitForIdle(context);
	} finally {
		await harness.close(context);
	}
}

/** MemoryStorage that keeps a detached copy of every committed batch. */
export class RecordingStorage extends MemoryStorage {
	readonly batches: StorageWrite[][] = [];

	override async commit(writes: readonly StorageWrite[], commitContext: Context): Promise<Seq> {
		const copy = structuredClone(writes) as StorageWrite[];
		const seq = await super.commit(writes, commitContext);
		this.batches[seq - 1] = copy;
		return seq;
	}
}

let recorded: Promise<StorageWrite[][]> | undefined;

/** Genuine Pi commit batches, recorded once per test file from {@link runHarnessSession}. */
export function recordedBatches(): Promise<StorageWrite[][]> {
	recorded ??= (async () => {
		const storage = new RecordingStorage();
		await runHarnessSession(storage);
		const batches = storage.batches;
		for (let index = 0; index < batches.length; index++) {
			if (!batches[index]) throw new Error(`recorded session skipped seq ${index + 1}`);
		}
		return batches;
	})();
	return recorded;
}

// ─── Snapshot of every Pi read ──────────────────────────────────────────────

async function scanAll<T>(
	scan: (
		cursor: Cursor | undefined,
	) => Promise<{ readonly items: readonly T[]; readonly next?: Cursor }>,
): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

async function settle<T>(read: () => Promise<T>): Promise<T | { readonly error: string }> {
	try {
		return await read();
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Every Pi read API over everything `storage` holds, including historical
 * document reads at every seq up to `lastSeq`. Small pages exercise cursors.
 */
export async function snapshotReads(
	storage: Storage,
	lastSeq: number,
): Promise<Record<string, unknown>> {
	const snapshot: Record<string, unknown> = {};
	const conversations = await scanAll((cursor) =>
		storage.scanConversations({}, 2, cursor, context),
	);
	snapshot.conversations = conversations;
	const scopes: { kind: string; [key: string]: unknown }[] = [{ kind: 'session' }];
	for (const conversation of conversations) {
		const id = conversation.id;
		scopes.push({ kind: 'conversation', conversationId: id });
		const entries = await scanAll((cursor) =>
			storage.scanEntries({ conversationId: id }, 3, cursor, context),
		);
		snapshot[`entries:${id}`] = entries;
		snapshot[`head:${id}`] = await storage.findLatestHeadMarker(id, undefined, context);
		for (const entry of entries) {
			snapshot[`entry:${entry.id}`] = await storage.entry(entry.id, context);
			snapshot[`entry:${id}/${entry.id}`] = await storage.entry(id, entry.id, context);
			snapshot[`head:${id}@${entry.id}`] = await storage.findLatestHeadMarker(
				id,
				entry.id,
				context,
			);
		}
	}
	const tasks = await scanAll((cursor) => storage.scanTasks({}, 2, cursor, context));
	snapshot.tasks = tasks;
	for (const task of tasks) {
		snapshot[`task:${task.id}`] = await storage.task(task.id, context);
		scopes.push({ kind: 'task', taskId: task.id });
	}
	for (const status of ['pending', 'running', 'waiting', 'completing', 'terminal'] as const) {
		snapshot[`tasks:${status}`] = await scanAll((cursor) =>
			storage.scanTasks({ status }, 2, cursor, context),
		);
	}
	const submissions = await scanAll((cursor) => storage.scanSubmissions({}, 2, cursor, context));
	snapshot.submissions = submissions;
	for (const submission of submissions) {
		snapshot[`submission:${submission.id}`] = await storage.submission(submission.id, context);
		if (submission.requestId !== undefined) {
			snapshot[`request:${submission.conversationId}/${submission.requestId}`] =
				await storage.submissionByRequest(submission.conversationId, submission.requestId, context);
		}
	}
	const points = [
		'current' as const,
		...Array.from({ length: lastSeq }, (_, index) => (index + 1) as Seq),
	];
	for (const scope of scopes) {
		for (const at of points) {
			const documents = await scanAll((cursor) =>
				storage.scanDocuments({ scope: scope as never, at }, 3, cursor, context),
			);
			const key = `${JSON.stringify(scope)}@${at}`;
			snapshot[`docs:${key}`] = documents;
			for (const document of documents) {
				snapshot[`doc:${document.id}@${at}`] = await settle(() =>
					storage.document(document.id, at, context),
				);
				snapshot[`find:${key}/${document.kind}/${document.key ?? ''}`] = await settle(() =>
					storage.findDocument(
						{
							kind: document.kind,
							scope: scope as never,
							...(document.key === undefined ? {} : { key: document.key }),
						},
						at,
						context,
					),
				);
			}
		}
	}
	return snapshot;
}

// ─── The crash/replay suite ─────────────────────────────────────────────────

export interface CrashSuiteBackend {
	/** A log; every call may return a new client of the same backing store. */
	log(): DurableStreamLog;
	/** Prepended to every Pi log path so runs on a shared server stay apart. */
	readonly pathPrefix: string;
}

/**
 * The §2.4 crash matrix, replay, epoch and fencing cases, against any log.
 * Real Pi commit batches are replayed one per `commit`, so seq `n` of the
 * recorded session is seq `n` here.
 */
export function defineStreamStorageCrashTests(label: string, backend: CrashSuiteBackend): void {
	describe(label, () => {
		const opened: StreamStorage[] = [];
		let counter = 0;
		const freshPath = () =>
			`${backend.pathPrefix}${crypto.randomUUID().slice(0, 8)}-${counter++}/pi`;

		async function open(options: Parameters<typeof openStreamStorage>[0]): Promise<OpenedStorage> {
			const result = await openStreamStorage(options);
			opened.push(result.storage);
			return result;
		}

		afterEach(async () => {
			for (const storage of opened) await storage.close(context).catch(() => {});
			opened.length = 0;
			await removeTempFiles();
		});

		async function commitAll(
			storage: StreamStorage,
			batches: readonly StorageWrite[][],
			from: number,
			to: number,
		) {
			for (let index = from; index < to; index++) {
				const seq = await storage.commit(batches[index] as StorageWrite[], context);
				expect(seq).toBe(index + 1);
			}
		}

		function expectEachSeqOnce(envelopes: readonly PiCommitEnvelope[], count: number): void {
			expect(envelopes.map((envelope) => envelope.seq)).toEqual(
				Array.from({ length: count }, (_, i) => i + 1),
			);
		}

		async function expectRebuildsIdentically(
			log: DurableStreamLog,
			path: string,
			expected: unknown,
			seqs: number,
		) {
			const fresh = await open({ file: await tempFile(), log, path });
			expect(await snapshotReads(fresh.storage, seqs)).toEqual(expected);
		}

		it('crash before the local transaction: nothing durable, the retry commits once', async () => {
			const batches = await recordedBatches();
			const log = backend.log();
			const path = freshPath();
			const file = await tempFile();
			const database = new FaultyDatabase(await openNodeSqliteDatabase(file));
			const first = await open({ database, log, path, publish: 'await' });
			await commitAll(first.storage, batches, 0, 3);
			database.failNextTransaction = true;
			await expect(first.storage.commit(batches[3] as StorageWrite[], context)).rejects.toThrow(
				CrashError,
			);
			await first.storage.close(context);

			const second = await open({ file, log, path, publish: 'await' });
			await commitAll(second.storage, batches, 3, 5);
			const envelopes = await loggedEnvelopes(log, path);
			expectEachSeqOnce(envelopes, 5);
			const reads = await snapshotReads(second.storage, 5);
			await expectRebuildsIdentically(log, path, reads, 5);
		});

		it('crash after the local transaction, before the POST: reopening publishes the row once', async () => {
			const batches = await recordedBatches();
			const inner = backend.log();
			const faulty = new FaultyLog(inner);
			const path = freshPath();
			const file = await tempFile();
			const first = await open({ file, log: faulty, path, publish: 'await' });
			await commitAll(first.storage, batches, 0, 3);
			faulty.crashNextAppend('before-append');
			// The commit resolves: a publish failure is never a commit failure.
			expect(await first.storage.commit(batches[3] as StorageWrite[], context)).toBe(4);
			expect(first.storage.outbox.pending()).toBe(1);
			const before = await snapshotReads(first.storage, 4);
			await first.storage.close(context);
			expectEachSeqOnce(await loggedEnvelopes(inner, path), 3);

			const second = await open({ file, log: inner, path, publish: 'await' });
			expect(await second.storage.drain()).toMatchObject({
				status: expect.stringMatching(/idle|published/),
			});
			expect(second.storage.outbox.pending()).toBe(0);
			expectEachSeqOnce(await loggedEnvelopes(inner, path), 4);
			expect(await snapshotReads(second.storage, 4)).toEqual(before);
			await commitAll(second.storage, batches, 4, 6);
			expectEachSeqOnce(await loggedEnvelopes(inner, path), 6);
			await expectRebuildsIdentically(inner, path, await snapshotReads(second.storage, 6), 6);
		});

		it('crash after the append, before the local ack: the retry deduplicates within the epoch', async () => {
			const batches = await recordedBatches();
			const inner = backend.log();
			const faulty = new FaultyLog(inner);
			const path = freshPath();
			const file = await tempFile();
			const first = await open({ file, log: faulty, path, publish: 'await' });
			await commitAll(first.storage, batches, 0, 3);
			faulty.crashNextAppend('drop-ack');
			expect(await first.storage.commit(batches[3] as StorageWrite[], context)).toBe(4);
			expect(first.storage.outbox.pending()).toBe(1);
			const before = await snapshotReads(first.storage, 4);
			await first.storage.close(context);
			expectEachSeqOnce(await loggedEnvelopes(inner, path), 4);

			const recording = new FaultyLog(inner);
			const second = await open({ file, log: recording, path, publish: 'await' });
			await second.storage.drain();
			expect(second.storage.outbox.pending()).toBe(0);
			// Same epoch, same producer seq: the server answered duplicate.
			expect(recording.appends[0]).toMatchObject({
				producer: { epoch: 0, seq: 3 },
				outcome: 'duplicate',
			});
			expectEachSeqOnce(await loggedEnvelopes(inner, path), 4);
			expect(await snapshotReads(second.storage, 4)).toEqual(before);
			await commitAll(second.storage, batches, 4, 6);
			expectEachSeqOnce(await loggedEnvelopes(inner, path), 6);
			await expectRebuildsIdentically(inner, path, await snapshotReads(second.storage, 6), 6);
		});

		it('rebuilds a discarded index under a new epoch; Stream-Seq deduplicates rows that already landed', async () => {
			const batches = await recordedBatches();
			const inner = backend.log();
			const faulty = new FaultyLog(inner);
			const path = freshPath();
			const file = await tempFile();
			const first = await open({ file, log: faulty, path, publish: 'await' });
			await commitAll(first.storage, batches, 0, 3);
			faulty.crashNextAppend('drop-ack');
			await first.storage.commit(batches[3] as StorageWrite[], context);
			await first.storage.close(context);
			// Seq 4 is on the log, but the database still holds its outbox row.

			const blocked = new FaultyLog(inner);
			blocked.block();
			const second = await open({ file, log: blocked, path });
			const before = await snapshotReads(second.storage, 4);
			await second.storage.rebuild(context);
			expect(await snapshotReads(second.storage, 4)).toEqual(before);
			expect(second.storage.outbox.requireProducer()).toMatchObject({ epoch: 1, publishedSeq: 4 });
			expect(second.storage.outbox.pendingRows().map((row) => [row.seq, row.producerSeq])).toEqual([
				[4, 0],
			]);
			expect(await second.storage.commit(batches[4] as StorageWrite[], context)).toBe(5);
			expect(second.storage.outbox.pendingRows().map((row) => [row.seq, row.producerSeq])).toEqual([
				[4, 0],
				[5, 1],
			]);

			blocked.revive();
			blocked.appends.length = 0;
			await second.storage.drain();
			expect(second.storage.outbox.pending()).toBe(0);
			expect(second.fences).toEqual([]);
			// Seq 4: a stream-seq conflict consumes nothing, so seq 5 goes out
			// as (epoch 1, producer seq 0) again — never 1, which a new epoch
			// could not start at.
			expect(
				blocked.appends.map((append) => [
					append.streamSeq,
					append.producer.epoch,
					append.producer.seq,
					append.outcome,
				]),
			).toEqual([
				['0000000000000004', 1, 0, 'stream-seq-conflict'],
				['0000000000000005', 1, 0, 'appended'],
			]);
			expectEachSeqOnce(await loggedEnvelopes(inner, path), 5);
			await expectRebuildsIdentically(inner, path, await snapshotReads(second.storage, 5), 5);
		});

		it('opens a fresh database over a log that holds commits: rebuild, then a higher epoch', async () => {
			const batches = await recordedBatches();
			const log = backend.log();
			const path = freshPath();
			const first = await open({ file: await tempFile(), log, path, publish: 'await' });
			await commitAll(first.storage, batches, 0, 4);
			const reads = await snapshotReads(first.storage, 4);
			const incarnation = first.storage.incarnation;
			await first.storage.close(context);

			const recording = new FaultyLog(log);
			const second = await open({ file: await tempFile(), log: recording, path, publish: 'await' });
			expect(second.storage.incarnation).toBe(incarnation);
			expect(await snapshotReads(second.storage, 4)).toEqual(reads);
			expect(second.storage.outbox.requireProducer().epoch).toBe(1);
			await commitAll(second.storage, batches, 4, 5);
			expect(recording.appends.at(-1)).toMatchObject({
				producer: { epoch: 1, seq: 0 },
				outcome: 'appended',
			});
			expectEachSeqOnce(await loggedEnvelopes(log, path), 5);
		});

		it('fences and poisons the older of two writers on the same log', async () => {
			const batches = await recordedBatches();
			const log = backend.log();
			const path = freshPath();
			const older = await open({ file: await tempFile(), log, path, publish: 'await' });
			await commitAll(older.storage, batches, 0, 3);

			const newer = await open({ file: await tempFile(), log, path, publish: 'await' });
			await commitAll(newer.storage, batches, 3, 4);
			expect(newer.fences).toEqual([]);

			// The older writer still commits locally (the contract), then is fenced.
			expect(await older.storage.commit(batches[3] as StorageWrite[], context)).toBe(4);
			expect(older.fences).toEqual([{ epoch: 1, reason: 'epoch' }]);
			expect(older.storage.fenced).toBeInstanceOf(Error);
			await expect(older.storage.commit(batches[4] as StorageWrite[], context)).rejects.toThrow(
				/fenced/,
			);
			const envelopes = await loggedEnvelopes(log, path);
			expectEachSeqOnce(envelopes, 4);
		});

		it('detects a writer that diverged at the same seq', async () => {
			const batches = await recordedBatches();
			const log = backend.log();
			const path = freshPath();
			const a = await open({ file: await tempFile(), log, path, publish: 'await' });
			await commitAll(a.storage, batches, 0, 3);
			const b = await open({ file: await tempFile(), log, path, publish: 'await' });
			// A publishes seq 4 before B does; B's own seq 4 is a different commit.
			await commitAll(a.storage, batches, 3, 4);
			await b.storage.commit(batches[4] as StorageWrite[], context);
			expect(b.fences).toEqual([{ epoch: 1, reason: 'diverged' }]);
			const envelopes = await loggedEnvelopes(log, path);
			expectEachSeqOnce(envelopes, 4);
		});

		it('refuses a log recreated under a different incarnation', async () => {
			const batches = await recordedBatches();
			const log = backend.log();
			const path = freshPath();
			const file = await tempFile();
			const a = await open({ file, log, path, publish: 'await' });
			await commitAll(a.storage, batches, 0, 2);
			await a.storage.close(context);
			const otherPath = freshPath();
			const other = await open({ file: await tempFile(), log, path: otherPath, publish: 'await' });
			await commitAll(other.storage, batches, 0, 1);
			await other.storage.close(context);
			// The database was published to `path`; pointing it at a log of another incarnation fails.
			const moved = await openNodeSqliteDatabase(file);
			moved.exec(`UPDATE flue_pi_producer SET path = '${otherPath}'`);
			await expect(openStreamStorage({ database: moved, log, path: otherPath })).rejects.toThrow(
				/incarnation/,
			);
		});
	});
}
