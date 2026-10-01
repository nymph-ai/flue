/**
 * Flue's Durable Object adapters inside workerd, on real Durable Object
 * SQLite (`SqliteProbe`, `probe.ts`): Pi's own storage conformance through
 * `doSqliteDatabase`, the row counters fed by real cursors, and the doorbell
 * — the wake book's high-water mark and `setAlarm(now)` written in one
 * synchronous turn — surviving until the alarm drains it.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { describe, expect, it } from 'vitest';
import { doSqliteDatabase } from '../do-sqlite-database.ts';
import type { SqliteProbe } from './probe.ts';

const namespace = (env as unknown as { SQLITE_PROBE: DurableObjectNamespace<SqliteProbe> })
	.SQLITE_PROBE;

registerStorageConformance(
	{ describe, expect, it },
	'SqliteStorage over Durable Object SQLite (workerd)',
	async (use) => {
		const stub = namespace.get(namespace.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const storage = await SqliteStorage.open(doSqliteDatabase(state.storage));
			try {
				await use(storage);
			} finally {
				await storage.close(BACKGROUND_CONTEXT).catch(() => {});
			}
		});
	},
);

describe('Durable Object SQLite in workerd', () => {
	it('counts what the cursors report', async () => {
		const stub = namespace.get(namespace.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const db = doSqliteDatabase(state.storage);
			db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
			const before = { ...db.rows };
			db.prepare('INSERT INTO t (id, v) VALUES (?, ?), (?, ?)').run(1, 'a', 2, 'b');
			expect(db.rows.rowsWritten - before.rowsWritten).toBeGreaterThanOrEqual(2);
			const read = db.rows.rowsRead;
			expect(db.prepare('SELECT v FROM t WHERE id = ?').get(2)).toEqual({ v: 'b' });
			expect(db.rows.rowsRead - read).toBeGreaterThanOrEqual(1);
		});
	});

	it('records a rung doorbell and arms the alarm, which drains it', async () => {
		const stub = namespace.get(namespace.newUniqueId());
		const head = '0000000000000000_0000000000000042';
		await stub.doorbell('flue/v1/bob/b1/inbox', head);
		// A duplicate and a stale ring change nothing.
		await stub.doorbell('flue/v1/bob/b1/inbox', head);
		await stub.doorbell('flue/v1/bob/b1/inbox', '0000000000000000_0000000000000007');
		// Miniflare may already have run the alarm the doorbell set for now; run it if not.
		await runDurableObjectAlarm(stub);
		expect(await stub.behind()).toBe(false);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(
				state.storage.sql.exec('SELECT path, head, cursor FROM flue_entity_streams').toArray(),
			).toEqual([{ path: 'flue/v1/bob/b1/inbox', head, cursor: head }]);
		});
	});
});
