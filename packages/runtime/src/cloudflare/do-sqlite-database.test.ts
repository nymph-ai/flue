/**
 * `DoSqliteDatabase` against a stand-in for Durable Object SQLite: node:sqlite
 * behind the `ctx.storage.sql.exec` / `transactionSync` surface (DO SQL has no
 * public prepare; `transactionSync` nests as savepoints and rolls back on a
 * throw). The runtime package has no `@cloudflare/vitest-pool-workers` wiring,
 * so the workerd run of this facade belongs to the Cloudflare qualification
 * step; this pins the facade's own behavior and runs Pi's storage conformance
 * through it, as Pi's own SqliteStorage.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { describe, expect, it } from 'vitest';
import { doSqliteDatabase } from './do-sqlite-database.ts';
import { FakeDurableObjectStorage } from './do-sqlite-test-support.ts';

describe('DoSqliteDatabase', () => {
	it('maps bindings and results to what DO SQL carries', async () => {
		const db = doSqliteDatabase(new FakeDurableObjectStorage());
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, b BLOB, s TEXT)');
		db.prepare('INSERT INTO t (id, n, b, s) VALUES (?, ?, ?, ?)').run(
			1,
			42n,
			new Uint8Array([1, 2, 3]),
			'x',
		);
		expect(db.prepare('SELECT n, b, s FROM t WHERE id = ?').get(1)).toEqual({
			n: 42,
			b: new Uint8Array([1, 2, 3]),
			s: 'x',
		});
		expect(db.prepare('SELECT id FROM t').all()).toEqual([{ id: 1 }]);
		expect(db.prepare('SELECT id FROM t WHERE id = ?').get(2)).toBeUndefined();
		expect(() => db.prepare('SELECT ?').get(2n ** 60n)).toThrow(RangeError);
	});

	it('rolls a throwing transaction back and rethrows the same error', async () => {
		const db = doSqliteDatabase(new FakeDurableObjectStorage());
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
		const failure = new Error('boom');
		expect(() =>
			db.transactionSync(() => {
				db.prepare('INSERT INTO t (id) VALUES (?)').run(1);
				throw failure;
			}),
		).toThrow(failure);
		expect(db.prepare('SELECT id FROM t').all()).toEqual([]);
		expect(db.transactionSync(() => 7)).toBe(7);
		expect(() => db.transactionSync(() => Promise.resolve(1) as any)).toThrow(/synchronous/);

		await expect(
			db.transaction(async (tx) => {
				await tx.run('INSERT INTO t (id) VALUES (?)', 2);
				throw failure;
			}),
		).rejects.toThrow(failure);
		expect(db.prepare('SELECT id FROM t WHERE id = ?').get(2)).toBeUndefined();
		const result = await db.transaction(async (tx) => {
			await tx.run('INSERT INTO t (id) VALUES (?)', 2);
			return 42;
		});
		expect(result).toBe(42);
		expect(db.prepare('SELECT id FROM t WHERE id = ?').get(2)).toEqual({ id: 2 });
	});
});

describe('DoSqliteDatabase row counters', () => {
	it("accumulates every cursor's rowsRead and rowsWritten, one counter per storage", async () => {
		const storage = new FakeDurableObjectStorage();
		const db = doSqliteDatabase(storage);
		expect(doSqliteDatabase(storage)).toBe(db);
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
		db.prepare('INSERT INTO t (id) VALUES (?), (?)').run(1, 2);
		expect(db.rows).toEqual({ rowsRead: 0, rowsWritten: 2 });
		db.prepare('SELECT id FROM t').all();
		db.prepare('SELECT id FROM t WHERE id = ?').get(1);
		expect(db.rows).toEqual({ rowsRead: 3, rowsWritten: 2 });
	});
});

registerStorageConformance(
	{ describe, expect, it },
	'SqliteStorage over the Durable Object SQLite facade',
	async (use) => {
		const storage = await SqliteStorage.open(doSqliteDatabase(new FakeDurableObjectStorage()));
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT).catch(() => {});
		}
	},
);
