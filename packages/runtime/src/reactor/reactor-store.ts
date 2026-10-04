/**
 * FlueReactorStore: the two SQLite tables that back AgentDO coordination:
 *
 * 1. `flue_entity_streams`: inbound streams, head, committed cursor
 * 2. `flue_outbox`: outbound semantic effects (undelivered obligations only)
 *
 * Row in `flue_outbox` = undelivered obligation.
 * Absence of row = delivered.
 *
 * Cost: only externally meaningful semantic events (settlements, questions, A2A sends)
 * touch the outbox. No Pi state, no tokens, no intermediate reasoning.
 */
import type { CountingSqliteDatabase } from '../cloudflare/do-sqlite-database.ts';
import { compareOffsets, STREAM_START } from '../streams/offset.ts';

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS flue_entity_streams (
		path TEXT PRIMARY KEY,
		head TEXT NOT NULL,
		cursor TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS flue_outbox (
		event_id TEXT PRIMARY KEY,
		stream TEXT NOT NULL,
		event_json TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		retry_at INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS idx_flue_outbox_retry ON flue_outbox (retry_at)`,
	`DROP TABLE IF EXISTS flue_settlement_projections`,
	`CREATE VIEW IF NOT EXISTS flue_streams AS SELECT path, head, cursor FROM flue_entity_streams`,
];

export interface WakeStreamState {
	readonly path: string;
	readonly head: string;
	readonly cursor: string;
}

export interface OutboxEntry {
	readonly eventId: string;
	readonly stream: string;
	readonly eventJson: string;
	readonly attempts: number;
	readonly retryAt: number;
}

export class FlueReactorStore {
	readonly #db: CountingSqliteDatabase;
	#schema = false;

	constructor(database: CountingSqliteDatabase) {
		this.#db = database;
		this.#ensure();
	}

	#ensure(): void {
		if (this.#schema) return;
		for (const statement of SCHEMA) {
			try {
				this.#db.prepare(statement).run();
			} catch {
				// Ignore if view/index already exists or is harmless
			}
		}
		this.#schema = true;
	}

	// ─── Inbound Streams ────────────────────────────────────────────────────────

	/**
	 * Record that `path` holds events through `head`. Synchronous. Returns
	 * whether the stream is behind its head afterwards.
	 */
	ringStream(path: string, head: string): boolean {
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

	/** Alias for ringStream. */
	ring(path: string, head: string): boolean {
		return this.ringStream(path, head);
	}

	/** Streams whose cursor is behind their head. */
	pendingStreams(): WakeStreamState[] {
		this.#ensure();
		return this.#db
			.prepare('SELECT path, head, cursor FROM flue_entity_streams')
			.all<WakeStreamState>()
			.filter((stream) => compareOffsets(stream.cursor, stream.head) < 0);
	}

	/** Alias for pendingStreams. */
	pending(): WakeStreamState[] {
		return this.pendingStreams();
	}

	/** Whether any stream is behind its head. */
	behind(): boolean {
		return this.pendingStreams().length > 0;
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
	advanceStream(path: string, cursor: string): void {
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

	/** Alias for advanceStream. */
	advance(path: string, cursor: string): void {
		this.advanceStream(path, cursor);
	}

	// ─── Semantic Outbox ────────────────────────────────────────────────────────

	/** Enqueue an outbound semantic event. Idempotent: INSERT OR IGNORE by event_id. */
	enqueue(entry: {
		readonly id: string;
		readonly stream: string;
		readonly event: unknown;
	}): void {
		this.#ensure();
		const eventJson = typeof entry.event === 'string' ? entry.event : JSON.stringify(entry.event);
		this.#db
			.prepare(
				'INSERT OR IGNORE INTO flue_outbox (event_id, stream, event_json, attempts, retry_at) VALUES (?, ?, ?, 0, 0)',
			)
			.run(entry.id, entry.stream, eventJson);
	}

	/** Pending events ready for delivery (retry_at <= now). Ordered by retry_at ASC. */
	pendingEvents(now: number, limit = 50): OutboxEntry[] {
		this.#ensure();
		const rows = this.#db
			.prepare(
				'SELECT event_id, stream, event_json, attempts, retry_at FROM flue_outbox WHERE retry_at <= ? ORDER BY retry_at ASC, attempts ASC LIMIT ?',
			)
			.all<{
				event_id: string;
				stream: string;
				event_json: string;
				attempts: number;
				retry_at: number;
			}>(now, limit);
		return rows.map((r) => ({
			eventId: r.event_id,
			stream: r.stream,
			eventJson: r.event_json,
			attempts: r.attempts,
			retryAt: r.retry_at,
		}));
	}

	/**
	 * Earliest retry timestamp among all pending outbox rows, if any.
	 * Returns undefined when outbox is empty.
	 */
	earliestRetry(): number | undefined {
		this.#ensure();
		const row = this.#db
			.prepare('SELECT MIN(retry_at) AS earliest FROM flue_outbox')
			.get<{ earliest: number | null }>();
		return row?.earliest !== null && row?.earliest !== undefined ? Number(row.earliest) : undefined;
	}

	/** Mark an event delivered by deleting it from the outbox. */
	delivered(eventId: string): void {
		this.#ensure();
		this.#db.prepare('DELETE FROM flue_outbox WHERE event_id = ?').run(eventId);
	}

	/** Mark an event delivery attempt failed, incrementing attempts and setting next retry_at. */
	failed(eventId: string, retryAt: number): void {
		this.#ensure();
		this.#db
			.prepare(
				'UPDATE flue_outbox SET attempts = attempts + 1, retry_at = ? WHERE event_id = ?',
			)
			.run(retryAt, eventId);
	}

	/** Single outbox entry by event_id, if present. */
	getOutboxEntry(eventId: string): OutboxEntry | undefined {
		this.#ensure();
		const row = this.#db
			.prepare(
				'SELECT event_id, stream, event_json, attempts, retry_at FROM flue_outbox WHERE event_id = ?',
			)
			.get<{
				event_id: string;
				stream: string;
				event_json: string;
				attempts: number;
				retry_at: number;
			}>(eventId);
		if (!row) return undefined;
		return {
			eventId: row.event_id,
			stream: row.stream,
			eventJson: row.event_json,
			attempts: row.attempts,
			retryAt: row.retry_at,
		};
	}

	/** Number of pending outbox obligations. */
	outboxCount(): number {
		this.#ensure();
		const row = this.#db
			.prepare('SELECT COUNT(*) AS n FROM flue_outbox')
			.get<{ n: number }>();
		return row?.n ?? 0;
	}
}
