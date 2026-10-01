/**
 * A stand-in for Durable Object SQLite in Node tests: node:sqlite behind the
 * `ctx.storage.sql.exec` / `transactionSync` surface. DO SQL has no public
 * prepare; `transactionSync` nests as savepoints and rolls back on a throw.
 * Cursors report `rowsRead` (rows returned) and `rowsWritten` (rows changed),
 * a lower bound of what workerd reports for the same statements.
 *
 * Imported only by tests.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { DurableObjectSqliteStorage } from './do-sqlite-database.ts';

type DoValue = ArrayBuffer | string | number | null;

/** node:sqlite shaped like `DurableObjectStorage` (`sql.exec` + `transactionSync`). */
export class FakeDurableObjectStorage implements DurableObjectSqliteStorage {
	readonly database = new DatabaseSync(':memory:');
	private depth = 0;

	readonly sql = {
		exec: (query: string, ...bindings: DoValue[]) => {
			for (const binding of bindings) {
				// DO SQL rejects anything outside SqlStorageValue.
				if (!(
					binding === null ||
					typeof binding === 'string' ||
					typeof binding === 'number' ||
					binding instanceof ArrayBuffer
				)) {
					throw new TypeError(`unsupported binding ${typeof binding}`);
				}
			}
			const values = bindings.map((binding) =>
				binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
			) as SQLInputValue[];
			const statement = this.database.prepare(query);
			let rows: Record<string, unknown>[] = [];
			let rowsWritten = 0;
			if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
				rows = statement.all(...values) as Record<string, unknown>[];
			} else {
				rowsWritten = Number(statement.run(...values).changes);
			}
			// DO returns blobs as ArrayBuffer.
			const converted = rows.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([key, value]) => [
						key,
						value instanceof Uint8Array
							? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
							: value,
					]),
				),
			);
			return { toArray: () => converted, rowsRead: rows.length, rowsWritten };
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
