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
import type { SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import type {
	CountingSqliteDatabase,
	SqliteRowCounters,
	SqliteStatement,
} from '../cloudflare/do-sqlite-database.ts';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface NodeSqliteDatabaseOptions {
	/** Time SQLite waits for a competing file lock (default 5,000 ms). */
	readonly busyTimeoutMs?: number;
}

export class NodeSqliteDatabase implements CountingSqliteDatabase {
	readonly rows: SqliteRowCounters = { rowsRead: 0, rowsWritten: 0 };
	/** Per-statement counters, once `traceStatements()` turned them on (diagnosis, tests). */
	statements: Map<string, SqliteRowCounters> | undefined;
	readonly #database: DatabaseSync;
	readonly #cachedStatements = new Map<string, StatementSync>();
	#closed = false;

	constructor(database: DatabaseSync) {
		this.#database = database;
	}

	/** Count rows per statement text from now on. */
	traceStatements(): Map<string, SqliteRowCounters> {
		this.statements ??= new Map();
		return this.statements;
	}

	private statement(sql: string): StatementSync {
		let stmt = this.#cachedStatements.get(sql);
		if (!stmt) {
			stmt = this.#database.prepare(sql);
			this.#cachedStatements.set(sql, stmt);
		}
		return stmt;
	}

	async exec(sql: string): Promise<void> {
		this.#database.exec(sql);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		const stmt = this.statement(sql);
		const changes = Number(stmt.run(...(params as SQLInputValue[])).changes);
		this.rows.rowsWritten += changes;
		if (this.statements) {
			const counters = this.statements.get(sql) ?? { rowsRead: 0, rowsWritten: 0 };
			counters.rowsWritten += changes;
			this.statements.set(sql, counters);
		}
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		const stmt = this.statement(sql);
		const row = stmt.get(...(params as SQLInputValue[])) as T | undefined;
		this.rows.rowsRead += row === undefined ? 0 : 1;
		if (this.statements) {
			const counters = this.statements.get(sql) ?? { rowsRead: 0, rowsWritten: 0 };
			counters.rowsRead += row === undefined ? 0 : 1;
			this.statements.set(sql, counters);
		}
		return row;
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		const stmt = this.statement(sql);
		const all = stmt.all(...(params as SQLInputValue[])) as T[];
		this.rows.rowsRead += all.length;
		if (this.statements) {
			const counters = this.statements.get(sql) ?? { rowsRead: 0, rowsWritten: 0 };
			counters.rowsRead += all.length;
			this.statements.set(sql, counters);
		}
		return all;
	}

	prepare(sql: string): SqliteStatement {
		const statement: StatementSync = this.statement(sql);
		const count = (read: number, written: number) => {
			this.rows.rowsRead += read;
			this.rows.rowsWritten += written;
			if (!this.statements) return;
			const counters = this.statements.get(sql) ?? { rowsRead: 0, rowsWritten: 0 };
			counters.rowsRead += read;
			counters.rowsWritten += written;
			this.statements.set(sql, counters);
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

	async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const result = await callback(this);
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

	transactionSync<T>(callback: () => T): T {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const result = callback();
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

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#cachedStatements.clear();
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
