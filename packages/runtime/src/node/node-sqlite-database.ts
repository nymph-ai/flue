/**
 * Pi's `SqliteDatabase` facade over `node:sqlite`, for Pi's own
 * `SqliteStorage` on Node (docs/cloudflare-native.md rule 1). It behaves like
 * pi-durable 0.99.2's `NodeSqliteDatabase` (`BEGIN IMMEDIATE` / `COMMIT`,
 * rollback-then-rethrow, WAL with a busy timeout) and adds what that one has
 * no hook for: row counters, the Node equivalent of a Durable Object cursor's
 * `rowsRead`/`rowsWritten`. Writes count the rows a statement changed; reads
 * count the rows it returned (SQLite does not report the rows a statement
 * scanned through `node:sqlite`), so they are a lower bound of what workerd
 * would bill.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type { SqliteStatement, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import type {
	CountingSqliteDatabase,
	SqliteRowCounters,
} from '../cloudflare/do-sqlite-database.ts';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface NodeSqliteDatabaseOptions {
	/** Time SQLite waits for a competing file lock (default 5,000 ms). */
	readonly busyTimeoutMs?: number;
}

export class NodeSqliteDatabase implements CountingSqliteDatabase {
	readonly rows: SqliteRowCounters = { rowsRead: 0, rowsWritten: 0 };
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	exec(sql: string): void {
		this.#database.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		const statement: StatementSync = this.#database.prepare(sql);
		const count = (read: number, written: number) => {
			this.rows.rowsRead += read;
			this.rows.rowsWritten += written;
		};
		return {
			run: (...params: SqliteValue[]) => {
				count(0, Number(statement.run(...(params as SQLInputValue[])).changes));
			},
			get: <T extends object>(...params: SqliteValue[]) => {
				const row = statement.get(...(params as SQLInputValue[])) as T | undefined;
				count(row === undefined ? 0 : 1, 0);
				return row;
			},
			all: <T extends object>(...params: SqliteValue[]) => {
				const all = statement.all(...(params as SQLInputValue[])) as T[];
				count(all.length, 0);
				return all;
			},
		};
	}

	transaction<T>(callback: () => T): T {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const result = callback();
			if (
				result !== null &&
				(typeof result === 'object' || typeof result === 'function') &&
				typeof Reflect.get(result, 'then') === 'function'
			) {
				throw new TypeError('SQLite transaction callbacks must be synchronous');
			}
			this.#database.exec('COMMIT');
			return result;
		} catch (error) {
			try {
				this.#database.exec('ROLLBACK');
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					'SQLite transaction failed and rollback failed',
				);
			}
			throw error;
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}
}

/** Open a `node:sqlite` database (a file, or `:memory:`) for Pi's `SqliteStorage` and Flue's tables. */
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteDatabaseOptions = {},
): Promise<NodeSqliteDatabase> {
	if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
	const database = new DatabaseSync(path, {
		timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
	});
	const adapter = new NodeSqliteDatabase(database);
	try {
		if (path !== ':memory:') {
			adapter.exec('PRAGMA journal_mode = WAL');
			adapter.exec('PRAGMA synchronous = NORMAL');
		}
		return adapter;
	} catch (error) {
		adapter.close();
		throw error;
	}
}
