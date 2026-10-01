/**
 * The Pi commit outbox (PI_UPGRADE_PLAN.md §2.4): rows written in the same
 * SQLite transaction as the Pi commit, drained to the canonical Durable
 * Streams log one POST per row, in seq order, under an idempotent producer.
 *
 * Tables (a `flue_` prefix, clear of Pi's and `cf_agents_*`):
 *
 * - `flue_pi_outbox` — one row per unpublished commit: the envelope JSON and
 *   the `Producer-Seq` it will be sent with.
 * - `flue_pi_producer` — the single producer: id, epoch, the next producer seq
 *   to assign, what is known published, and the storage incarnation.
 * - `flue_pi_offsets` — Pi seq → `Stream-Next-Offset` after it (a cache).
 * - `flue_relay_outbox` / `flue_relay_producer` — A2A sends and publishes
 *   produced by the same commit, with per-target contiguous producer seqs.
 *   Their drainer is a later step; the co-transactional insert is here.
 *
 * Drain outcomes, with the protocol as the reference servers implement it
 * (`streams/log.ts`):
 *
 * - `appended` / `duplicate` — the row is on the log: delete it, record the
 *   offset. A 204 from the Node server carries no offset; `published_offset`
 *   then stays the last one known.
 * - `stream-seq-conflict` — the commit already landed (typically under an
 *   earlier epoch). A conflict consumes nothing on the server, so the
 *   remaining rows move down one producer seq: the next row is sent with the
 *   seq this one used.
 * - `producer-gap`, expected above ours — our earlier sends landed and their
 *   acks were lost: prune rows below the expected seq.
 * - `producer-gap`, expected below ours — the server lost our producer state:
 *   move to a new epoch, renumbered from producer seq 0 (a new epoch must
 *   start at 0), and let `Stream-Seq` deduplicate what already landed.
 * - `fenced` — a newer writer owns the stream: `onFenced`, and stop for good.
 * - `retryable` — back off and `armWake`.
 *
 * Every outcome in which the server claims a row already landed (duplicate,
 * stream-seq conflict, pruned gap) is checked against the envelope actually on
 * the log. A different commit at that seq means two writers diverged: that is
 * treated exactly like `fenced`.
 */

import { DurableStreamLogError, type AppendOutcome, type DurableStreamLog } from '../streams/log.ts';
import { STREAM_START, asStreamOffset, type StreamOffset } from '../streams/offset.ts';
import { type EntityAddress, relayItemsFor } from './a2a-entries.ts';
import {
	CommitAssembler,
	commitMessages,
	decodeCommitEnvelope,
	encodeCommitEnvelope,
	type PiCommitEnvelope,
	sameCommit,
	streamSeqFor,
} from './commit-envelope.ts';
import type { FencedSqliteDatabase } from './fenced-sqlite-database.ts';

export type DrainResult =
	| { readonly status: 'idle' | 'published' }
	| { readonly status: 'backoff'; readonly retryAt: number; readonly error: unknown }
	| { readonly status: 'fenced'; readonly currentEpoch: number; readonly reason: FenceReason }
	| { readonly status: 'closed' };

/** `epoch`: the server answered 403. `diverged`: the log holds a different commit at one of our seqs. */
export type FenceReason = 'epoch' | 'diverged';

export interface CommitOutbox {
	/** Must be called synchronously inside the index transaction. */
	enqueueSync(envelope: PiCommitEnvelope): void;
	pending(): number;
	/** Publishes in seq order; never throws on a retryable failure. */
	drain(signal?: AbortSignal): Promise<DrainResult>;
	publishedThrough(): { readonly seq: number; readonly nextOffset?: string } | undefined;
}

export interface ProducerState {
	readonly path: string;
	readonly producerId: string;
	readonly epoch: number;
	readonly nextProducerSeq: number;
	readonly publishedSeq: number;
	readonly publishedOffset: StreamOffset | undefined;
	readonly incarnation: string;
}

export interface OutboxRow {
	readonly seq: number;
	readonly body: string;
	readonly producerSeq: number;
}

export interface SqliteCommitOutboxOptions {
	readonly database: FencedSqliteDatabase;
	readonly log: DurableStreamLog;
	readonly path: string;
	/** The entity whose commits these are; relay rows are addressed from it. */
	readonly entity: EntityAddress;
	/** Envelopes above this many UTF-8 bytes are split into parts (one POST still). Default 1 MiB. */
	readonly maxMessageBytes?: number;
	readonly now?: () => number;
	/** Called with the time a backed-off drain should run again. Without it, a timer is used. */
	readonly armWake?: (atMs: number) => void | Promise<void>;
	/** Called once when the outbox is fenced or finds the log diverged. */
	readonly onFenced: (epoch: number, reason: FenceReason) => void;
	readonly onReport?: (error: unknown) => void;
	readonly backoff?: { readonly initialMs?: number; readonly maxMs?: number };
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS flue_pi_outbox (
		seq INTEGER PRIMARY KEY,
		body TEXT NOT NULL,
		producer_seq INTEGER NOT NULL,
		created_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS flue_pi_producer (
		path TEXT PRIMARY KEY,
		producer_id TEXT NOT NULL,
		epoch INTEGER NOT NULL,
		next_producer_seq INTEGER NOT NULL,
		published_seq INTEGER NOT NULL,
		published_offset TEXT,
		storage_incarnation TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS flue_pi_offsets (
		seq INTEGER PRIMARY KEY,
		next_offset TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS flue_relay_outbox (
		id INTEGER PRIMARY KEY,
		seq INTEGER NOT NULL,
		target TEXT NOT NULL,
		body TEXT NOT NULL,
		producer_id TEXT NOT NULL,
		producer_epoch INTEGER NOT NULL,
		producer_seq INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS flue_relay_producer (
		target TEXT NOT NULL,
		producer_id TEXT NOT NULL,
		epoch INTEGER NOT NULL,
		next_producer_seq INTEGER NOT NULL,
		PRIMARY KEY (target, producer_id)
	)`,
];

type ProducerRow = {
	readonly path: string;
	readonly producer_id: string;
	readonly epoch: number | bigint;
	readonly next_producer_seq: number | bigint;
	readonly published_seq: number | bigint;
	readonly published_offset: string | null;
	readonly storage_incarnation: string;
};
type RowShape = { readonly seq: number | bigint; readonly body: string; readonly producer_seq: number | bigint };
type CountRow = { readonly n: number | bigint };
type OffsetRow = { readonly next_offset: string };
type RelayProducerRow = { readonly epoch: number | bigint; readonly next_producer_seq: number | bigint };

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

function toRow(row: RowShape): OutboxRow {
	return { seq: Number(row.seq), body: row.body, producerSeq: Number(row.producer_seq) };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, Math.max(ms, 0));
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** Create the outbox tables (idempotent). Call inside a transaction. */
export function ensureCommitOutboxSchema(database: { exec(sql: string): void }): void {
	for (const statement of SCHEMA) database.exec(statement);
}

export class SqliteCommitOutbox implements CommitOutbox {
	private readonly db: FencedSqliteDatabase;
	private readonly log: DurableStreamLog;
	private readonly path: string;
	private readonly entity: EntityAddress;
	private readonly maxMessageBytes: number;
	private readonly now: () => number;
	private readonly armWake: SqliteCommitOutboxOptions['armWake'];
	private readonly onFenced: SqliteCommitOutboxOptions['onFenced'];
	private readonly onReport: (error: unknown) => void;
	private readonly initialBackoffMs: number;
	private readonly maxBackoffMs: number;

	/** The last scheduled drain pass; passes run one at a time. */
	private chain: Promise<unknown> = Promise.resolve();
	/** A pass scheduled behind the running one that has not started yet. */
	private queued: Promise<DrainResult> | undefined;
	private attempts = 0;
	private wakeTimer: ReturnType<typeof setTimeout> | undefined;
	private fence: { readonly epoch: number; readonly reason: FenceReason } | undefined;
	private closed = false;
	private readonly abort = new AbortController();

	constructor(options: SqliteCommitOutboxOptions) {
		this.db = options.database;
		this.log = options.log;
		this.path = options.path;
		this.entity = options.entity;
		this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		this.now = options.now ?? Date.now;
		this.armWake = options.armWake;
		this.onFenced = options.onFenced;
		this.onReport = options.onReport ?? (() => {});
		this.initialBackoffMs = options.backoff?.initialMs ?? 250;
		this.maxBackoffMs = options.backoff?.maxMs ?? 30_000;
	}

	// ─── Producer state ──────────────────────────────────────────────────────

	producer(): ProducerState | undefined {
		const row = this.db
			.prepare(
				`SELECT path, producer_id, epoch, next_producer_seq, published_seq, published_offset, storage_incarnation
				FROM flue_pi_producer`,
			)
			.all<ProducerRow>();
		const only = row[0];
		if (!only) return undefined;
		if (row.length > 1 || only.path !== this.path) {
			throw new Error(`[flue] This database's Pi outbox belongs to "${only.path}", not "${this.path}".`);
		}
		return {
			path: only.path,
			producerId: only.producer_id,
			epoch: Number(only.epoch),
			nextProducerSeq: Number(only.next_producer_seq),
			publishedSeq: Number(only.published_seq),
			publishedOffset: only.published_offset === null ? undefined : asStreamOffset(only.published_offset),
			incarnation: only.storage_incarnation,
		};
	}

	requireProducer(): ProducerState {
		const producer = this.producer();
		if (!producer) throw new Error('[flue] The Pi outbox has no producer state.');
		return producer;
	}

	/** Insert the producer row. Call inside a transaction. */
	initProducerSync(state: Omit<ProducerState, 'path'>): void {
		this.db
			.prepare(
				`INSERT INTO flue_pi_producer
				(path, producer_id, epoch, next_producer_seq, published_seq, published_offset, storage_incarnation)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.path,
				state.producerId,
				state.epoch,
				state.nextProducerSeq,
				state.publishedSeq,
				state.publishedOffset ?? null,
				state.incarnation,
			);
	}

	// ─── Enqueue (inside the Pi commit transaction) ──────────────────────────

	enqueueSync(envelope: PiCommitEnvelope): void {
		const producer = this.requireProducer();
		if (envelope.epoch !== producer.epoch || envelope.storage !== producer.incarnation) {
			throw new Error('[flue] Envelope epoch/incarnation does not match the outbox producer.');
		}
		this.db
			.prepare('INSERT INTO flue_pi_outbox (seq, body, producer_seq, created_at) VALUES (?, ?, ?, ?)')
			.run(envelope.seq, encodeCommitEnvelope(envelope), producer.nextProducerSeq, envelope.at);
		this.db
			.prepare('UPDATE flue_pi_producer SET next_producer_seq = ? WHERE path = ?')
			.run(producer.nextProducerSeq + 1, this.path);
		for (const item of relayItemsFor(envelope.writes, this.entity)) {
			const relay = this.db
				.prepare(
					'SELECT epoch, next_producer_seq FROM flue_relay_producer WHERE target = ? AND producer_id = ?',
				)
				.get<RelayProducerRow>(item.target, item.producerId);
			// A relay producer follows the Pi producer's epoch: a rebuilt index
			// starts every relay target over at seq 0 of the new epoch.
			const sameEpoch = relay !== undefined && Number(relay.epoch) === producer.epoch;
			const producerSeq = sameEpoch ? Number(relay.next_producer_seq) : 0;
			this.db
				.prepare(
					`INSERT INTO flue_relay_producer (target, producer_id, epoch, next_producer_seq) VALUES (?, ?, ?, ?)
					ON CONFLICT (target, producer_id) DO UPDATE SET epoch = excluded.epoch, next_producer_seq = excluded.next_producer_seq`,
				)
				.run(item.target, item.producerId, producer.epoch, producerSeq + 1);
			this.db
				.prepare(
					`INSERT INTO flue_relay_outbox (seq, target, body, producer_id, producer_epoch, producer_seq)
					VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(envelope.seq, item.target, JSON.stringify(item.body), item.producerId, producer.epoch, producerSeq);
		}
	}

	// ─── Inspection ──────────────────────────────────────────────────────────

	pending(): number {
		const row = this.db.prepare('SELECT COUNT(*) AS n FROM flue_pi_outbox').get<CountRow>();
		return Number(row?.n ?? 0);
	}

	pendingRows(): OutboxRow[] {
		return this.db
			.prepare('SELECT seq, body, producer_seq FROM flue_pi_outbox ORDER BY seq')
			.all<RowShape>()
			.map(toRow);
	}

	publishedThrough(): { readonly seq: number; readonly nextOffset?: string } | undefined {
		const producer = this.producer();
		if (!producer || producer.publishedSeq === 0) return undefined;
		return producer.publishedOffset === undefined
			? { seq: producer.publishedSeq }
			: { seq: producer.publishedSeq, nextOffset: producer.publishedOffset };
	}

	/** Relay rows waiting for the relay drainer, oldest first. */
	relayRows(): {
		readonly seq: number;
		readonly target: string;
		readonly body: unknown;
		readonly producerId: string;
		readonly producerEpoch: number;
		readonly producerSeq: number;
	}[] {
		return this.db
			.prepare(
				'SELECT seq, target, body, producer_id, producer_epoch, producer_seq FROM flue_relay_outbox ORDER BY id',
			)
			.all<{
				seq: number | bigint;
				target: string;
				body: string;
				producer_id: string;
				producer_epoch: number | bigint;
				producer_seq: number | bigint;
			}>()
			.map((row) => ({
				seq: Number(row.seq),
				target: row.target,
				body: JSON.parse(row.body) as unknown,
				producerId: row.producer_id,
				producerEpoch: Number(row.producer_epoch),
				producerSeq: Number(row.producer_seq),
			}));
	}

	get fenced(): { readonly epoch: number; readonly reason: FenceReason } | undefined {
		return this.fence;
	}

	// ─── Epochs ──────────────────────────────────────────────────────────────

	/**
	 * Move to `epoch`: renumber pending rows from producer seq 0 in seq order
	 * and rewrite their envelopes' epoch. Call inside a transaction.
	 */
	startEpochSync(epoch: number): void {
		const rows = this.pendingRows();
		const update = this.db.prepare('UPDATE flue_pi_outbox SET body = ?, producer_seq = ? WHERE seq = ?');
		rows.forEach((row, index) => {
			const envelope = decodeCommitEnvelope(row.body);
			update.run(encodeCommitEnvelope({ ...envelope, epoch }), index, row.seq);
		});
		this.db
			.prepare('UPDATE flue_pi_producer SET epoch = ?, next_producer_seq = ? WHERE path = ?')
			.run(epoch, rows.length, this.path);
	}

	/** Record what a rebuild replayed. Call inside a transaction. */
	recordReplaySync(publishedSeq: number, publishedOffset: StreamOffset, offsets: ReadonlyMap<number, string>): void {
		this.db.exec('DELETE FROM flue_pi_offsets');
		const insert = this.db.prepare('INSERT INTO flue_pi_offsets (seq, next_offset) VALUES (?, ?)');
		for (const [seq, offset] of offsets) insert.run(seq, offset);
		this.db
			.prepare('UPDATE flue_pi_producer SET published_seq = ?, published_offset = ? WHERE path = ?')
			.run(publishedSeq, publishedOffset, this.path);
	}

	// ─── Drain ───────────────────────────────────────────────────────────────

	/**
	 * One drain pass after any running one. A pass that has not started yet
	 * already covers every row committed so far, so callers share it.
	 */
	drain(signal?: AbortSignal): Promise<DrainResult> {
		if (this.queued) return this.queued;
		const pass = this.chain.then(() => {
			this.queued = undefined;
			return this.drainOnce(signal);
		});
		this.queued = pass;
		this.chain = pass.catch(() => {});
		return pass;
	}

	/**
	 * Drain until `seq` is published or `deadline` (ms since the epoch)
	 * passes. Never throws; `false` means not (yet) published.
	 */
	async waitForPublished(seq: number, deadline: number): Promise<boolean> {
		while (!this.closed && !this.fence) {
			const result = await this.drain();
			if ((this.producer()?.publishedSeq ?? 0) >= seq && !this.isPending(seq)) return true;
			if (result.status === 'fenced' || result.status === 'closed') return false;
			const now = this.now();
			if (now >= deadline) return false;
			// A backoff past the deadline will not publish in time.
			if (result.status === 'backoff' && result.retryAt >= deadline) return false;
			const wakeAt = result.status === 'backoff' ? result.retryAt : now + 10;
			await sleep(Math.min(wakeAt, deadline) - now, this.abort.signal);
		}
		return false;
	}

	/** Stop draining; an in-flight append is aborted. */
	async close(): Promise<void> {
		this.closed = true;
		if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
		this.abort.abort();
		await this.chain;
	}

	private isPending(seq: number): boolean {
		return this.db.prepare('SELECT seq FROM flue_pi_outbox WHERE seq = ?').get(seq) !== undefined;
	}

	private async drainOnce(external: AbortSignal | undefined): Promise<DrainResult> {
		const signal = external ? AbortSignal.any([external, this.abort.signal]) : this.abort.signal;
		let published = false;
		while (true) {
			if (this.fence) return { status: 'fenced', currentEpoch: this.fence.epoch, reason: this.fence.reason };
			if (this.closed || signal.aborted) return { status: 'closed' };
			const head = this.db
				.prepare('SELECT seq, body, producer_seq FROM flue_pi_outbox ORDER BY seq LIMIT 1')
				.get<RowShape>();
			if (!head) {
				this.attempts = 0;
				return { status: published ? 'published' : 'idle' };
			}
			const row = toRow(head);
			const producer = this.requireProducer();
			let outcome: AppendOutcome;
			try {
				outcome = await this.log.append(
					this.path,
					{
						messages: commitMessages(row.body, this.maxMessageBytes),
						producer: { id: producer.producerId, epoch: producer.epoch, seq: row.producerSeq },
						streamSeq: streamSeqFor(row.seq),
					},
					signal,
				);
			} catch (error) {
				if (this.closed || signal.aborted) return { status: 'closed' };
				if (error instanceof DurableStreamLogError && error.code === 'not-found') {
					// The stream was never created (or the log lost it): create and retry.
					try {
						await this.log.ensure(this.path, signal);
						continue;
					} catch (ensureError) {
						return this.backoff(ensureError);
					}
				}
				if (!(error instanceof DurableStreamLogError && error.retryable)) this.onReport(error);
				return this.backoff(error);
			}
			if (this.closed) return { status: 'closed' };
			try {
				const step = await this.apply(row, producer, outcome, signal);
				if (step === 'published') published = true;
				else if (step !== 'continue') return step;
			} catch (error) {
				if (this.closed || signal.aborted) return { status: 'closed' };
				this.onReport(error);
				return this.backoff(error);
			}
		}
	}

	private async apply(
		row: OutboxRow,
		producer: ProducerState,
		outcome: AppendOutcome,
		signal: AbortSignal,
	): Promise<'published' | 'continue' | DrainResult> {
		switch (outcome.status) {
			case 'appended':
				await this.db.transactionUnarmed(() => {
					this.deleteRow(row.seq);
					this.markPublished(row.seq, outcome.nextOffset);
					this.db
						.prepare('INSERT OR REPLACE INTO flue_pi_offsets (seq, next_offset) VALUES (?, ?)')
						.run(row.seq, outcome.nextOffset);
				});
				this.attempts = 0;
				return 'published';
			case 'duplicate': {
				// An in-epoch retry of a send whose ack was lost.
				const verdict = await this.verifyLogged([row], signal);
				if (verdict !== true) return verdict;
				await this.db.transactionUnarmed(() => {
					this.deleteRow(row.seq);
					this.markPublished(row.seq, outcome.nextOffset);
				});
				this.attempts = 0;
				return 'published';
			}
			case 'stream-seq-conflict': {
				// Landed before (typically under an earlier epoch). The server
				// consumed nothing, so this producer seq is still the next one.
				const verdict = await this.verifyLogged([row], signal);
				if (verdict !== true) return verdict;
				await this.db.transactionUnarmed(() => {
					this.deleteRow(row.seq);
					this.db
						.prepare('UPDATE flue_pi_outbox SET producer_seq = producer_seq - 1 WHERE seq > ?')
						.run(row.seq);
					this.db
						.prepare('UPDATE flue_pi_producer SET next_producer_seq = next_producer_seq - 1 WHERE path = ?')
						.run(this.path);
					this.markPublished(row.seq, outcome.nextOffset);
				});
				this.attempts = 0;
				return 'published';
			}
			case 'producer-gap': {
				if (outcome.expectedSeq > row.producerSeq) {
					// Our sends up to expectedSeq - 1 landed; their acks were lost.
					const landed = this.pendingRows().filter((pending) => pending.producerSeq < outcome.expectedSeq);
					const verdict = await this.verifyLogged(landed, signal);
					if (verdict !== true) return verdict;
					await this.db.transactionUnarmed(() => {
						for (const pending of landed) this.deleteRow(pending.seq);
						const last = landed.at(-1);
						if (last) this.markPublished(last.seq, undefined);
					});
					return 'published';
				}
				// The server forgot this producer (or never saw it): a new epoch,
				// from producer seq 0; Stream-Seq deduplicates what already landed.
				this.onReport(
					new Error(
						`[flue] Durable stream "${this.path}" expects producer seq ${outcome.expectedSeq} ` +
							`below ours (${row.producerSeq}); moving to epoch ${producer.epoch + 1}.`,
					),
				);
				await this.db.transactionUnarmed(() => this.startEpochSync(producer.epoch + 1));
				return 'continue';
			}
			case 'fenced':
				return this.poison(outcome.currentEpoch, 'epoch');
			case 'retryable':
				return this.backoff(outcome.error);
		}
	}

	/**
	 * `true` when the log holds exactly these rows' commits at their seqs;
	 * otherwise the fence (divergence) or a backoff (the log could not be read).
	 */
	private async verifyLogged(rows: readonly OutboxRow[], signal: AbortSignal): Promise<true | DrainResult> {
		if (rows.length === 0) return true;
		const wanted = new Map(rows.map((row) => [row.seq, decodeCommitEnvelope(row.body)]));
		const first = rows[0] as OutboxRow;
		const last = rows.at(-1) as OutboxRow;
		const start =
			this.db
				.prepare('SELECT next_offset FROM flue_pi_offsets WHERE seq < ? ORDER BY seq DESC LIMIT 1')
				.get<OffsetRow>(first.seq)?.next_offset ?? STREAM_START;
		let offset = asStreamOffset(start);
		const assembler = new CommitAssembler();
		try {
			while (wanted.size > 0) {
				const batch = await this.log.read(this.path, offset, { signal });
				for (const message of batch.messages) {
					const logged = assembler.accept(message);
					if (!logged || logged.seq < first.seq) continue;
					const ours = wanted.get(logged.seq);
					if (ours === undefined || !sameCommit(ours, logged)) {
						return this.poison(this.requireProducer().epoch, 'diverged');
					}
					wanted.delete(logged.seq);
					if (logged.seq >= last.seq) break;
				}
				offset = batch.nextOffset;
				if (batch.upToDate || batch.messages.length === 0) break;
			}
		} catch (error) {
			return this.backoff(error);
		}
		// The server says these landed, yet the log does not show them.
		return wanted.size === 0 ? true : this.poison(this.requireProducer().epoch, 'diverged');
	}

	private deleteRow(seq: number): void {
		this.db.prepare('DELETE FROM flue_pi_outbox WHERE seq = ?').run(seq);
	}

	private markPublished(seq: number, nextOffset: StreamOffset | undefined): void {
		if (nextOffset === undefined) {
			this.db
				.prepare('UPDATE flue_pi_producer SET published_seq = MAX(published_seq, ?) WHERE path = ?')
				.run(seq, this.path);
		} else {
			this.db
				.prepare(
					'UPDATE flue_pi_producer SET published_seq = MAX(published_seq, ?), published_offset = ? WHERE path = ?',
				)
				.run(seq, nextOffset, this.path);
		}
	}

	private poison(epoch: number, reason: FenceReason): DrainResult {
		if (!this.fence) {
			this.fence = { epoch, reason };
			try {
				this.onFenced(epoch, reason);
			} catch (error) {
				this.onReport(error);
			}
		}
		return { status: 'fenced', currentEpoch: this.fence.epoch, reason: this.fence.reason };
	}

	private backoff(error: unknown): DrainResult {
		const delay = Math.min(this.initialBackoffMs * 2 ** this.attempts, this.maxBackoffMs);
		this.attempts = Math.min(this.attempts + 1, 30);
		const retryAt = this.now() + delay;
		if (!this.closed) {
			if (this.armWake) {
				Promise.resolve()
					.then(() => this.armWake?.(retryAt))
					.catch((wakeError) => this.onReport(wakeError));
			} else {
				if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
				this.wakeTimer = setTimeout(() => {
					this.wakeTimer = undefined;
					void this.drain().catch((drainError) => this.onReport(drainError));
				}, delay);
				(this.wakeTimer as { unref?: () => void }).unref?.();
			}
		}
		return { status: 'backoff', retryAt, error };
	}
}
