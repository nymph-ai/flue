/**
 * Persisted-store format versioning.
 *
 * Every persisted Flue store durably records the format version it was
 * created with, and refuses to open a store recorded with an unknown or newer
 * version. This is a storage-agnostic obligation of the
 * {@link PersistenceAdapter} contract: the built-in SQL backends implement it
 * with a one-row `flue_meta` key/value table; non-SQL adapters implement the
 * same obligation natively (a key, a meta document, etc.).
 */

import { PersistedFormatVersionError } from './errors.ts';
import type { SqlStorage } from './sql-storage.ts';

/**
 * Current format version of Flue's built-in persisted stores.
 *
 * Bump this when a persisted format changes incompatibly. Stores recorded
 * with an unknown or newer version are rejected and must be cleared.
 *
 * - 1: the pre-Pi runtime (submission rows, canonical conversation records).
 * - 2: Pi Durable (PI_UPGRADE_PLAN.md §7 step 8): every agent instance's
 *   canonical log is a stream of Pi commit envelopes; submissions are Pi
 *   records. A format-1 store stays readable: its conversation streams are
 *   imported into Pi on each instance's first open, and SQL stores are
 *   relabelled 2 as they migrate.
 */
export const FLUE_FORMAT_VERSION = 2;

/** Versions this runtime reads: the current one, and format 1 for the one-time import. */
const READABLE_FORMAT_VERSIONS: ReadonlySet<string> = new Set(['1', String(FLUE_FORMAT_VERSION)]);

/**
 * Throw {@link PersistedFormatVersionError} unless the stored version matches
 * the current {@link FLUE_FORMAT_VERSION}.
 *
 * Adapters call this with the version value they recorded at store creation.
 * A version greater than the current one means the store was written by a
 * newer Flue version and must not be read; any other mismatch means the
 * version marker is unrecognized.
 */
export function assertSupportedFlueFormatVersion(storedVersion: string): void {
	if (READABLE_FORMAT_VERSIONS.has(storedVersion)) return;
	throw new PersistedFormatVersionError({
		storedVersion,
		supportedVersion: FLUE_FORMAT_VERSION,
	});
}

export function migrateFlueSqlSchema(sql: SqlStorage, ensureCurrentSchema: () => void): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_meta (
		 key TEXT PRIMARY KEY,
		 value TEXT NOT NULL
		)`,
	);
	const stored = sql
		.exec(`SELECT value FROM flue_meta WHERE key = 'format_version'`)
		.toArray()[0]?.value;
	if (stored !== undefined && stored !== null) {
		assertSupportedFlueFormatVersion(String(stored));
		if (String(stored) !== String(FLUE_FORMAT_VERSION)) {
			ensureCurrentSchema();
			// Format 1 → 2 is additive: Pi logs are new streams; legacy streams
			// stay where they are for the import. Relabel once the schema is in.
			sql.exec(
				`UPDATE flue_meta SET value = ? WHERE key = 'format_version'`,
				String(FLUE_FORMAT_VERSION),
			);
			return;
		}
	} else {
		const legacy = sql
			.exec(`SELECT value FROM flue_meta WHERE key = 'schema_version'`)
			.toArray()[0]?.value;
		if (legacy !== undefined && legacy !== null) {
			// Nightly-era stores stamped `schema_version` 8 hold storage shapes
			// byte-for-byte identical to format 1, so adoption is a pure
			// relabel of the stamp — no data rewrite. Any other value at the
			// old key names a store this runtime cannot read.
			if (String(legacy) !== '8') {
				throw new PersistedFormatVersionError({
					storedVersion: String(legacy),
					supportedVersion: FLUE_FORMAT_VERSION,
				});
			}
			// One UPDATE renames the row in place: atomic even on node:sqlite,
			// where nothing wraps this in a transaction, so the store is never
			// observable without a stamp at either key.
			sql.exec(
				`UPDATE flue_meta SET key = 'format_version', value = ? WHERE key = 'schema_version'`,
				String(FLUE_FORMAT_VERSION),
			);
		} else {
			const existing = sql
				.exec(
					String.raw`SELECT name FROM sqlite_master
					 WHERE type = 'table' AND name LIKE 'flue\_%' ESCAPE '\' AND name <> 'flue_meta'
					 LIMIT 1`,
				)
				.toArray()[0];
			if (existing) {
				throw new PersistedFormatVersionError({
					storedVersion: 'unversioned',
					supportedVersion: FLUE_FORMAT_VERSION,
				});
			}
			// Nothing wraps this in a transaction on node:sqlite, so the stamp
			// must land BEFORE any other DDL: a crash inside ensureCurrentSchema()
			// then leaves a versioned store that re-migrates cleanly instead of
			// tripping the unversioned-legacy rejection forever.
			sql.exec(
				`INSERT OR IGNORE INTO flue_meta (key, value) VALUES ('format_version', ?)`,
				String(FLUE_FORMAT_VERSION),
			);
		}
	}

	ensureCurrentSchema();
}
