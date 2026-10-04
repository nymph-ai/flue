/**
 * The wake book (docs/cloudflare-native.md rules 3 and 4): one Flue table in
 * the entity's own SQLite, `flue_entity_streams`, holding per stream
 *
 * - `head` — the high-water mark: the newest offset a doorbell reported;
 * - `cursor` — the committed cursor: every event through it is admitted.
 *
 * {@link EntityWakeBook.ring} is the doorbell: synchronous SQL only, so the
 * Durable Object writes it in the same synchronous turn as the wake job it
 * pushes, and both land in one coalesced, atomic storage write. A crash after
 * it returns loses nothing: the alarm fires, and the pump drains from the
 * cursor toward the head. Ringing again with an older or equal head (a
 * duplicate or stale webhook) changes nothing.
 *
 * Cost: a ring reads one row and writes at most one; listing pending streams
 * reads one row per stream the entity has ever been woken for (its inbox and
 * the streams it observes) — never anything that grows with its history.
 */
import type { CountingSqliteDatabase } from '../cloudflare/do-sqlite-database.ts';
import { compareOffsets, STREAM_START } from '../streams/offset.ts';

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS flue_entity_streams (
		path TEXT PRIMARY KEY,
		head TEXT NOT NULL,
		cursor TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS flue_settlement_projections (
		submission_id TEXT PRIMARY KEY
	)`,
];

export interface WakeStreamState {
	readonly path: string;
	readonly head: string;
	readonly cursor: string;
}

export class EntityWakeBook {
	readonly #db: CountingSqliteDatabase;
	#schema = false;

	constructor(database: CountingSqliteDatabase) {
		this.#db = database;
		this.#ensure();
	}

	#ensure(): void {
		if (this.#schema) return;
		for (const statement of SCHEMA) {
			this.#db.prepare(statement).run();
		}
		try {
			this.#db
				.prepare(
					"ALTER TABLE flue_settlement_projections ADD COLUMN state TEXT NOT NULL DEFAULT 'published'",
				)
				.run();
		} catch {
			// Column already exists or table was freshly created with state column
		}
		try {
			this.#db
				.prepare(
					"CREATE INDEX IF NOT EXISTS idx_flue_settlement_projections_pending ON flue_settlement_projections (submission_id) WHERE state = 'pending'",
				)
				.run();
		} catch {
			// Index already exists
		}
		this.#schema = true;
	}

	/** Whether a submission's settlement has been projected outward to Electric. */
	isSettlementPublished(submissionId: string): boolean {
		this.#ensure();
		const row = this.#db
			.prepare(
				"SELECT 1 FROM flue_settlement_projections WHERE submission_id = ? AND state = 'published'",
			)
			.get(submissionId);
		return Boolean(row);
	}

	/** Record that a submission's settlement is pending outward projection to Electric. */
	recordSettlementPending(submissionId: string): void {
		this.#ensure();
		this.#db
			.prepare(
				"INSERT OR IGNORE INTO flue_settlement_projections (submission_id, state) VALUES (?, 'pending')",
			)
			.run(submissionId);
	}

	/** Mark a submission's settlement as projected outward to Electric. */
	markSettlementPublished(submissionId: string): void {
		this.#ensure();
		this.#db
			.prepare(
				"INSERT INTO flue_settlement_projections (submission_id, state) VALUES (?, 'published') ON CONFLICT (submission_id) DO UPDATE SET state = 'published'",
			)
			.run(submissionId);
	}

	/** Submission IDs that have settled but not yet successfully projected to Electric. */
	pendingSettlementIds(): string[] {
		this.#ensure();
		const rows = this.#db
			.prepare("SELECT submission_id FROM flue_settlement_projections WHERE state = 'pending'")
			.all<{ submission_id: string }>();
		return rows.map((r) => r.submission_id);
	}

	/**
	 * Find which candidate submission IDs have not yet been projected to Electric.
	 * Returns unprojected IDs to retry and published IDs to cache.
	 */
	checkSettlementProjections(submissionIds: readonly string[]): {
		unprojected: string[];
		published: string[];
	} {
		if (submissionIds.length === 0) return { unprojected: [], published: [] };
		this.#ensure();
		const placeholders = submissionIds.map(() => '?').join(', ');
		const rows = this.#db
			.prepare(
				`SELECT submission_id, state FROM flue_settlement_projections WHERE submission_id IN (${placeholders})`,
			)
			.all<{ submission_id: string; state: string }>(...submissionIds);
		const publishedSet = new Set(
			rows.filter((r) => r.state === 'published').map((r) => r.submission_id),
		);
		const published = Array.from(publishedSet);
		const unprojected = submissionIds.filter((id) => !publishedSet.has(id));
		return { unprojected, published };
	}

	/**
	 * Record that `path` holds events through `head`. Synchronous. Returns
	 * whether the stream is behind its head afterwards.
	 */
	ring(path: string, head: string): boolean {
		this.#ensure();
		const row = this.#db
			.prepare('SELECT head, cursor FROM flue_entity_streams WHERE path = ?')
			.get<{ head: string; cursor: string }>(path);
		if (!row) {
			this.#db
				.prepare('INSERT INTO flue_entity_streams (path, head, cursor) VALUES (?, ?, ?)')
				.run(path, head, STREAM_START);
			return compareOffsets(STREAM_START, head) < 0;
		}
		if (compareOffsets(head, row.head) > 0) {
			this.#db.prepare('UPDATE flue_entity_streams SET head = ? WHERE path = ?').run(head, path);
			return compareOffsets(row.cursor, head) < 0;
		}
		return compareOffsets(row.cursor, row.head) < 0;
	}

	/** Streams whose cursor is behind their head. */
	pending(): WakeStreamState[] {
		this.#ensure();
		return this.#db
			.prepare('SELECT path, head, cursor FROM flue_entity_streams')
			.all<WakeStreamState>()
			.filter((stream) => compareOffsets(stream.cursor, stream.head) < 0);
	}

	/** Whether any stream is behind its head. */
	behind(): boolean {
		return this.pending().length > 0;
	}

	/** The committed cursor of `path` (`-1` before anything was admitted). */
	cursor(path: string): string {
		this.#ensure();
		return (
			this.#db
				.prepare('SELECT cursor FROM flue_entity_streams WHERE path = ?')
				.get<{ cursor: string }>(path)?.cursor ?? STREAM_START
		);
	}

	/**
	 * Commit the cursor of `path` forward to `cursor` (never backward). A
	 * read past the recorded head raises the head with it.
	 */
	advance(path: string, cursor: string): void {
		this.#ensure();
		const row = this.#db
			.prepare('SELECT head, cursor FROM flue_entity_streams WHERE path = ?')
			.get<{ head: string; cursor: string }>(path);
		if (!row) {
			this.#db
				.prepare('INSERT INTO flue_entity_streams (path, head, cursor) VALUES (?, ?, ?)')
				.run(path, cursor, cursor);
			return;
		}
		if (compareOffsets(cursor, row.cursor) <= 0) return;
		const head = compareOffsets(cursor, row.head) > 0 ? cursor : row.head;
		this.#db
			.prepare('UPDATE flue_entity_streams SET head = ?, cursor = ? WHERE path = ?')
			.run(head, cursor, path);
	}
}
