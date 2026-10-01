/**
 * Minimal SQL storage interface shared by Cloudflare DO SQLite and node:sqlite.
 *
 * This is an internal implementation detail — not part of the public adapter
 * contract. Adapter authors implement {@link AgentSubmissionStore}, not this.
 */

interface SqlResult {
	toArray(): Array<Record<string, unknown>>;
}

export interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}

/**
 * Whether `table` exists. A `LIMIT 0` read of it reads no rows; a
 * `sqlite_master` lookup reads every schema row, and Durable Object SQLite
 * bills rows read.
 */
export function sqlTableExists(sql: SqlStorage, table: string): boolean {
	try {
		sql.exec(`SELECT 1 FROM ${table} LIMIT 0`).toArray();
		return true;
	} catch {
		return false;
	}
}
