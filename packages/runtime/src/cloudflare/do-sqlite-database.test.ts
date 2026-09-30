/**
 * `DoSqliteDatabase` against a stand-in for Durable Object SQLite: node:sqlite
 * behind the `ctx.storage.sql.exec` / `transactionSync` surface (DO SQL has no
 * public prepare; `transactionSync` nests as savepoints and rolls back on a
 * throw). The runtime package has no `@cloudflare/vitest-pool-workers` wiring,
 * so the workerd run of this facade belongs to the Cloudflare qualification
 * step; this pins the facade's own behavior and runs Pi's storage conformance
 * through it.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { describe, expect, it } from 'vitest';
import { context, openStreamStorage } from '../pi/stream-storage-test-support.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import { type DurableObjectSqliteStorage, doSqliteDatabase } from './do-sqlite-database.ts';

type DoValue = ArrayBuffer | string | number | null;

/** node:sqlite shaped like `DurableObjectStorage` (`sql.exec` + `transactionSync`). */
class FakeDurableObjectStorage implements DurableObjectSqliteStorage {
	readonly database = new DatabaseSync(':memory:');
	private depth = 0;

	readonly sql = {
		exec: (query: string, ...bindings: DoValue[]) => {
			for (const binding of bindings) {
				// DO SQL rejects anything outside SqlStorageValue.
				if (!(binding === null || typeof binding === 'string' || typeof binding === 'number' || binding instanceof ArrayBuffer)) {
					throw new TypeError(`unsupported binding ${typeof binding}`);
				}
			}
			const values = bindings.map((binding) =>
				binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
			) as SQLInputValue[];
			const statement = this.database.prepare(query);
			let rows: Record<string, unknown>[] = [];
			if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) {
				rows = statement.all(...values) as Record<string, unknown>[];
			} else {
				statement.run(...values);
			}
			// DO returns blobs as ArrayBuffer.
			const converted = rows.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([key, value]) => [
						key,
						value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value,
					]),
				),
			);
			return { toArray: () => converted };
		},
	};

	transactionSync<T>(closure: () => T): T {
		const name = `do_tx_${this.depth++}`;
		this.database.exec(`SAVEPOINT ${name}`);
		try {
			const result = closure();
			this.database.exec(`RELEASE ${name}`);
			return result;
		} catch (error) {
			this.database.exec(`ROLLBACK TO ${name}`);
			this.database.exec(`RELEASE ${name}`);
			throw error;
		} finally {
			this.depth--;
		}
	}
}

describe('DoSqliteDatabase', () => {
	it('maps bindings and results to what DO SQL carries', () => {
		const db = doSqliteDatabase(new FakeDurableObjectStorage());
		db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, b BLOB, s TEXT)');
		db.prepare('INSERT INTO t (id, n, b, s) VALUES (?, ?, ?, ?)').run(1, 42n, new Uint8Array([1, 2, 3]), 'x');
		expect(db.prepare('SELECT n, b, s FROM t WHERE id = ?').get(1)).toEqual({
			n: 42,
			b: new Uint8Array([1, 2, 3]),
			s: 'x',
		});
		expect(db.prepare('SELECT id FROM t').all()).toEqual([{ id: 1 }]);
		expect(db.prepare('SELECT id FROM t WHERE id = ?').get(2)).toBeUndefined();
		expect(() => db.prepare('SELECT ?').get(2n ** 60n)).toThrow(RangeError);
	});

	it('rolls a throwing transaction back and rethrows the same error', () => {
		const db = doSqliteDatabase(new FakeDurableObjectStorage());
		db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
		const failure = new Error('boom');
		expect(() =>
			db.transaction(() => {
				db.prepare('INSERT INTO t (id) VALUES (?)').run(1);
				throw failure;
			}),
		).toThrow(failure);
		expect(db.prepare('SELECT id FROM t').all()).toEqual([]);
		expect(db.transaction(() => 7)).toBe(7);
		expect(() => db.transaction(() => Promise.resolve(1))).toThrow(/synchronous/);
	});
});

registerStorageConformance(
	{ describe, expect, it },
	'StreamStorage (Durable Object SQLite facade + InMemoryDurableStreamLog)',
	async (use) => {
		const { storage, fences } = await openStreamStorage({
			database: doSqliteDatabase(new FakeDurableObjectStorage()),
			log: new InMemoryDurableStreamLog(),
		});
		try {
			await use(storage);
		} finally {
			await storage.close(context).catch(() => {});
		}
		expect(fences).toEqual([]);
	},
);
