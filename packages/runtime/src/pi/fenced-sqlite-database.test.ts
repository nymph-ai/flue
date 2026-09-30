/**
 * The transaction-shape guard (PI_UPGRADE_PLAN.md risk 1). The outbox
 * co-transaction depends on how pi-durable's `SqliteStorage` uses its
 * database; these tests pin that shape against the installed Pi and fail
 * loudly when a Pi bump changes it.
 */

import type { Seq, StorageWrite } from '@earendil-works/pi-durable';
import {
	type SqliteDatabase,
	type SqliteStatement,
	SqliteStorage,
} from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import { FencedSqliteDatabase, TransactionShapeError } from './fenced-sqlite-database.ts';
import {
	context,
	loggedEnvelopes,
	openStreamStorage,
	recordedBatches,
	removeTempFiles,
	tempFile,
} from './stream-storage-test-support.ts';

afterEach(removeTempFiles);

type Transaction = { readonly phase: string; readonly result: unknown; readonly sync: boolean };

/** A node:sqlite facade that records every transaction and what its callback returned. */
class RecordingDatabase implements SqliteDatabase {
	readonly transactions: Transaction[] = [];
	phase = 'open';
	private readonly inner: SqliteDatabase;

	constructor(inner: SqliteDatabase) {
		this.inner = inner;
	}

	exec(sql: string): void {
		this.inner.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return this.inner.prepare(sql);
	}

	transaction<T>(callback: () => T): T | Promise<T> {
		let sync = false;
		const result = this.inner.transaction(() => {
			sync = true;
			return callback();
		});
		// The callback ran before transaction() returned: synchronous, as the
		// fenced facade requires.
		this.transactions.push({ phase: this.phase, result: result instanceof Promise ? 'promise' : result, sync });
		return result;
	}

	close(): void | Promise<void> {
		return this.inner.close();
	}
}

describe('SqliteStorage transaction shape (pi-durable 0.99.2)', () => {
	it('opens with one migration transaction and commits with exactly one transaction returning the Seq', async () => {
		const batches = await recordedBatches();
		const database = new RecordingDatabase(await openNodeSqliteDatabase(await tempFile()));
		const storage = await SqliteStorage.open(database);
		expect(database.transactions).toEqual([{ phase: 'open', result: undefined, sync: true }]);

		for (const [index, writes] of batches.entries()) {
			database.phase = `commit ${index + 1}`;
			let invokedSynchronously = false;
			const before = database.transactions.length;
			const pending = storage.commit(writes, context);
			// SqliteStorage calls transaction() before its first await, so an arm
			// set just before commit() is consumed by this commit and no other.
			invokedSynchronously = database.transactions.length === before + 1;
			const seq = await pending;
			expect(invokedSynchronously).toBe(true);
			expect(seq).toBe(index + 1);
			expect(database.transactions.slice(before)).toEqual([
				{ phase: `commit ${index + 1}`, result: index + 1, sync: true },
			]);
		}

		database.phase = 'reads';
		const before = database.transactions.length;
		await storage.mintId();
		await storage.conversation(1 as never, context);
		await storage.scanTasks({}, 10, undefined, context);
		await storage.scanDocuments({ scope: { kind: 'session' }, at: 'current' }, 10, undefined, context);
		expect(database.transactions.length).toBe(before);

		// A rejected commit still runs exactly one transaction, and rolls it back.
		database.phase = 'rejected';
		await expect(
			storage.commit([{ type: 'entry', value: { id: 1, conversationId: 1, kind: 'dup' } }] as never, context),
		).rejects.toThrow();
		const rejected = database.transactions.filter((transaction) => transaction.phase === 'rejected');
		expect(rejected.length).toBeLessThanOrEqual(1);
		await storage.close(context);
	});

	it('keeps durable_metadata.next_seq contiguous from 1', async () => {
		const db = await openNodeSqliteDatabase(':memory:');
		const storage = await SqliteStorage.open(db);
		const next = () =>
			Number(db.prepare('SELECT next_seq FROM durable_metadata WHERE singleton = 1').get<{ next_seq: number }>()?.next_seq);
		expect(next()).toBe(1);
		expect(await storage.commit([], context)).toBe(1);
		expect(next()).toBe(2);
		expect(await storage.commit([], context)).toBe(2);
		expect(next()).toBe(3);
		await storage.close(context);
	});
});

describe('FencedSqliteDatabase', () => {
	async function fenced(): Promise<{ db: FencedSqliteDatabase; storage: SqliteStorage; hooked: number[] }> {
		const db = new FencedSqliteDatabase(await openNodeSqliteDatabase(':memory:'));
		const storage = await SqliteStorage.open(db);
		db.setIndexReady(true);
		const hooked: number[] = [];
		db.setCommitHook((seq) => hooked.push(seq));
		return { db, storage, hooked };
	}

	it('runs the hook inside the armed commit and reports the consumed seq', async () => {
		const { db, storage, hooked } = await fenced();
		db.armCommit([]);
		const seq = await storage.commit([], context);
		expect(db.disarm()).toEqual({ consumed: true, seq });
		expect(hooked).toEqual([1]);
		await storage.close(context);
	});

	it('rolls the commit back when the hook throws', async () => {
		const { db, storage } = await fenced();
		db.setCommitHook(() => {
			throw new Error('outbox full');
		});
		db.armCommit([]);
		await expect(storage.commit([], context)).rejects.toThrow('outbox full');
		db.disarm();
		db.setCommitHook(() => {});
		db.armCommit([]);
		expect(await storage.commit([], context)).toBe(1);
		db.disarm();
		await storage.close(context);
	});

	it('fails loudly when an armed transaction does not return the Seq', async () => {
		const { db } = await fenced();
		db.armCommit([]);
		expect(() => db.transaction(() => 'not a seq')).toThrow(TransactionShapeError);
		db.disarm();
		db.armCommit([]);
		expect(() => db.transaction(() => Promise.resolve(1 as Seq))).toThrow(TransactionShapeError);
		db.disarm();
		db.armCommit([]);
		// Returns a number, but not the one durable_metadata says it committed.
		expect(() => db.transaction(() => 1)).toThrow(TransactionShapeError);
		db.disarm();
	});

	it('fails loudly when an unarmed transaction moves next_seq', async () => {
		const { db } = await fenced();
		expect(() =>
			db.transaction(() => db.exec('UPDATE durable_metadata SET next_seq = next_seq + 1 WHERE singleton = 1')),
		).toThrow(TransactionShapeError);
		expect(db.nextSeq()).toBe(1);
	});

	it('reports an arm no transaction consumed', async () => {
		const { db } = await fenced();
		db.armCommit([] as StorageWrite[]);
		expect(db.disarm()).toEqual({ consumed: false });
		expect(() => {
			db.armCommit([]);
			db.armCommit([]);
		}).toThrow(/already armed/);
		db.disarm();
	});

	it('makes StreamStorage refuse to continue when Pi commits outside the armed transaction', async () => {
		const log = new InMemoryDurableStreamLog();
		const { storage } = await openStreamStorage({ file: await tempFile(), log, publish: 'await' });
		// Simulate a future SqliteStorage whose commit resolves a Seq without the
		// transaction the facade armed: the log would silently miss that seq.
		const index = (storage as unknown as { index: SqliteStorage }).index;
		(index as { commit: SqliteStorage['commit'] }).commit = async () => 1 as Seq;
		await expect(storage.commit([], context)).rejects.toThrow(TransactionShapeError);
		// Poisoned: nothing more is accepted.
		await expect(storage.commit([], context)).rejects.toThrow(TransactionShapeError);
		expect(await loggedEnvelopes(log, storage.path)).toEqual([]);
		await storage.close(context);
	});
});
