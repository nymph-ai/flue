/**
 * Pi's `SqliteDatabase` facade over Durable Object SQLite
 * (`ctx.storage.sql` + `ctx.storage.transactionSync`), so `StreamStorage`
 * (and Pi's `SqliteStorage` index inside it) run on a DO with the index, the
 * outbox and the relay rows in one DO SQLite transaction.
 *
 * DO SQL has no prepared-statement handle in its public API, so a statement is
 * its SQL text, executed with `sql.exec` on each call. Bindings are mapped to
 * what DO SQL accepts (`ArrayBuffer | string | number | null`): a bigint must
 * be a safe integer, a `Uint8Array` is copied to an `ArrayBuffer`; blobs read
 * back as `Uint8Array`. `transactionSync` rolls back and rethrows when the
 * callback throws, which is exactly the facade's contract. `close()` is a
 * no-op: the Durable Object owns the database.
 */

import type {
	SqliteDatabase,
	SqliteStatement,
	SqliteValue,
} from '@earendil-works/pi-durable/storage/sqlite';

type DoSqlValue = ArrayBuffer | string | number | null;

/** The slice of `DurableObjectStorage` this facade uses. */
export interface DurableObjectSqliteStorage {
	readonly sql: {
		exec(query: string, ...bindings: DoSqlValue[]): { toArray(): Record<string, unknown>[] };
	};
	transactionSync<T>(closure: () => T): T;
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

class DoSqliteStatement implements SqliteStatement {
	private readonly storage: DurableObjectSqliteStorage;
	private readonly sql: string;

	constructor(storage: DurableObjectSqliteStorage, sql: string) {
		this.storage = storage;
		this.sql = sql;
	}

	run(...params: SqliteValue[]): void {
		this.storage.sql.exec(this.sql, ...params.map(toBinding)).toArray();
	}

	get<T extends object>(...params: SqliteValue[]): T | undefined {
		const row = this.storage.sql.exec(this.sql, ...params.map(toBinding)).toArray()[0];
		return row === undefined ? undefined : fromRow<T>(row);
	}

	all<T extends object>(...params: SqliteValue[]): T[] {
		return this.storage.sql
			.exec(this.sql, ...params.map(toBinding))
			.toArray()
			.map((row) => fromRow<T>(row));
	}
}

export class DoSqliteDatabase implements SqliteDatabase {
	private readonly storage: DurableObjectSqliteStorage;

	constructor(storage: DurableObjectSqliteStorage) {
		this.storage = storage;
	}

	exec(sql: string): void {
		this.storage.sql.exec(sql).toArray();
	}

	prepare(sql: string): SqliteStatement {
		return new DoSqliteStatement(this.storage, sql);
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

/** Pi `SqliteDatabase` over a Durable Object's SQLite storage (`ctx.storage`). */
export function doSqliteDatabase(storage: DurableObjectSqliteStorage): DoSqliteDatabase {
	return new DoSqliteDatabase(storage);
}
