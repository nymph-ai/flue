/**
 * Pi's `SqliteDatabase` facade over Durable Object SQLite
 * (`ctx.storage.sql` + `ctx.storage.transactionSync`), so Pi Durable runs on
 * its own `SqliteStorage` inside the Durable Object, and Flue's own tables
 * (stream cursors, the wake high-water, the conversation cache) share the
 * same database (docs/cloudflare-native.md rule 1). This is the documented
 * adapter of pi-durable 0.99.2 `storage/sqlite/database.ts`; nothing here
 * depends on how `SqliteStorage` shapes its transactions.
 *
 * DO SQL has no prepared-statement handle in its public API, so a statement is
 * its SQL text, executed with `sql.exec` on each call. Bindings are mapped to
 * what DO SQL accepts (`ArrayBuffer | string | number | null`): a bigint must
 * be a safe integer, a `Uint8Array` is copied to an `ArrayBuffer`; blobs read
 * back as `Uint8Array`. `transactionSync` rolls back and rethrows when the
 * callback throws, which is exactly the facade's contract. `close()` is a
 * no-op: the Durable Object owns the database.
 *
 * Every `sql.exec` cursor's `rowsRead`/`rowsWritten` — what Cloudflare bills
 * and charts per namespace — accumulate in {@link DoSqliteDatabase.rows}, so
 * tests and the qualification build can measure what a scenario costs.
 */

import type {
	SqliteDatabase,
	SqliteStatement,
	SqliteValue,
} from '@earendil-works/pi-durable/storage/sqlite';

type DoSqlValue = ArrayBuffer | string | number | null;

/** What one `sql.exec` returns: its rows, and (on workerd) what it cost. */
export interface DurableObjectSqlCursor {
	toArray(): Record<string, unknown>[];
	readonly rowsRead?: number;
	readonly rowsWritten?: number;
}

/** The slice of `DurableObjectStorage` this facade uses. */
export interface DurableObjectSqliteStorage {
	readonly sql: {
		exec(query: string, ...bindings: DoSqlValue[]): DurableObjectSqlCursor;
	};
	transactionSync<T>(closure: () => T): T;
}

/** Rows read and written through one database facade since it was created (or reset). */
export interface SqliteRowCounters {
	rowsRead: number;
	rowsWritten: number;
}

/** A database facade that counts the rows its statements read and write. */
export interface CountingSqliteDatabase extends SqliteDatabase {
	readonly rows: SqliteRowCounters;
}

function toBinding(value: SqliteValue): DoSqlValue {
	if (typeof value === 'bigint') {
		const number = Number(value);
		if (!Number.isSafeInteger(number)) {
			throw new RangeError(`[flue] Durable Object SQLite cannot bind bigint ${value}.`);
		}
		return number;
	}
	if (value instanceof Uint8Array) {
		return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
	}
	return value;
}

function fromRow<T>(row: Record<string, unknown>): T {
	let converted: Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(row)) {
		if (value instanceof ArrayBuffer) {
			converted ??= { ...row };
			converted[key] = new Uint8Array(value);
		}
	}
	return (converted ?? row) as T;
}

export class DoSqliteDatabase implements CountingSqliteDatabase {
	readonly rows: SqliteRowCounters = { rowsRead: 0, rowsWritten: 0 };
	private readonly storage: DurableObjectSqliteStorage;

	constructor(storage: DurableObjectSqliteStorage) {
		this.storage = storage;
	}

	/** Run one statement to completion and count what it cost. */
	run(sql: string, params: readonly SqliteValue[]): Record<string, unknown>[] {
		const cursor = this.storage.sql.exec(sql, ...params.map(toBinding));
		const rows = cursor.toArray();
		this.rows.rowsRead += cursor.rowsRead ?? 0;
		this.rows.rowsWritten += cursor.rowsWritten ?? 0;
		return rows;
	}

	exec(sql: string): void {
		this.run(sql, []);
	}

	prepare(sql: string): SqliteStatement {
		const run = (params: readonly SqliteValue[]) => this.run(sql, params);
		return {
			run: (...params) => {
				run(params);
			},
			get: <T extends object>(...params: SqliteValue[]) => {
				const row = run(params)[0];
				return row === undefined ? undefined : fromRow<T>(row);
			},
			all: <T extends object>(...params: SqliteValue[]) =>
				run(params).map((row) => fromRow<T>(row)),
		};
	}

	transaction<T>(callback: () => T): T {
		return this.storage.transactionSync(() => {
			const result = callback();
			if (
				result !== null &&
				(typeof result === 'object' || typeof result === 'function') &&
				typeof Reflect.get(result, 'then') === 'function'
			) {
				throw new TypeError('SQLite transaction callbacks must be synchronous');
			}
			return result;
		});
	}

	close(): void {}
}

const databases = new WeakMap<DurableObjectSqliteStorage, DoSqliteDatabase>();

/**
 * Pi `SqliteDatabase` over a Durable Object's SQLite storage (`ctx.storage`).
 * One facade per storage, so every user of the object's database shares one
 * set of row counters.
 */
export function doSqliteDatabase(storage: DurableObjectSqliteStorage): DoSqliteDatabase {
	let database = databases.get(storage);
	if (!database) {
		database = new DoSqliteDatabase(storage);
		databases.set(storage, database);
	}
	return database;
}
