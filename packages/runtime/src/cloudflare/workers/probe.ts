/**
 * A SQLite-backed Durable Object of the workers-pool test Worker
 * (`codemode/workers/test-worker.ts` exports it) that holds Flue's Durable
 * Object adapters exactly as an agent's
 * object does — Pi's `SqliteStorage` over `doSqliteDatabase(ctx.storage)`,
 * the wake book rung in the same synchronous turn as `setAlarm(now)`, and an
 * alarm that drains it.
 *
 * Imported only by `*.workers.test.ts`.
 */
import { DurableObject } from 'cloudflare:workers';
import { EntityWakeBook } from '../../entity/wake-book.ts';
import { doSqliteDatabase } from '../do-sqlite-database.ts';

export class SqliteProbe extends DurableObject {
	/** The doorbell: the high-water mark and the alarm, in one synchronous turn. */
	doorbell(stream: string, head: string): Promise<void> {
		new EntityWakeBook(doSqliteDatabase(this.ctx.storage)).ring(stream, head);
		return this.ctx.storage.setAlarm(Date.now());
	}

	behind(): boolean {
		return new EntityWakeBook(doSqliteDatabase(this.ctx.storage)).behind();
	}

	/** The pump, reduced to its bookkeeping: every stream's cursor moves to its head. */
	async alarm(): Promise<void> {
		const book = new EntityWakeBook(doSqliteDatabase(this.ctx.storage));
		for (const stream of book.pending()) book.advance(stream.path, stream.head);
	}
}
