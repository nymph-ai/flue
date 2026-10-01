/**
 * The wake book (docs/cloudflare-native.md rules 3 and 4): one Flue table in
 * the entity's own SQLite, `flue_entity_streams`, holding per stream
 *
 * - `head` — the high-water mark: the newest offset a doorbell reported;
 * - `cursor` — the committed cursor: every event through it is admitted.
 *
 * {@link EntityWakeBook.ring} is the doorbell: synchronous SQL only, so the
 * Durable Object writes it in the same synchronous turn as `setAlarm(now)`
 * and both land in one coalesced, atomic storage write. A crash after it
 * returns loses nothing: the alarm fires, and the pump drains from the
 * cursor toward the head. Ringing again with an older or equal head (a
 * duplicate or stale webhook) changes nothing.
 *
 * Cost: a ring reads one row and writes at most one; listing pending streams
 * reads one row per stream the entity has ever been woken for (its inbox and
 * the streams it observes) — never anything that grows with its history.
 */
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { compareOffsets, STREAM_START } from '../streams/offset.ts';

const SCHEMA = `CREATE TABLE IF NOT EXISTS flue_entity_streams (
	path TEXT PRIMARY KEY,
	head TEXT NOT NULL,
	cursor TEXT NOT NULL
)`;

export interface WakeStreamState {
	readonly path: string;
	readonly head: string;
	readonly cursor: string;
}

export class EntityWakeBook {
	readonly #db: SqliteDatabase;
	#schema = false;

	constructor(database: SqliteDatabase) {
		this.#db = database;
	}

	#ensure(): void {
		if (this.#schema) return;
		this.#db.exec(SCHEMA);
		this.#schema = true;
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
