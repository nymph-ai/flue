/**
 * The relay drainer (PI_UPGRADE_PLAN.md §2.5 "send"/"publish"): posts the
 * `flue_relay_outbox` rows a Pi commit wrote co-transactionally to their
 * target streams — a target entity's inbox for `flue.a2a.send`, this entity's
 * events stream for `flue.publish` — exactly once, in commit order, with a
 * per-`(target, producer)` contiguous producer seq.
 *
 * Rules:
 *
 * - **Gated on the Pi log.** A row is posted only once the Pi commit that
 *   wrote it is on the canonical log (no `flue_pi_outbox` row at or below its
 *   seq). A receiver therefore never acts on a message its sender's history
 *   could lose, and — the relay-epoch fix — no relay producer ever sends under
 *   an epoch that is not on the sender's Pi log: relay producers follow the Pi
 *   epoch (`enqueueSync`), a fresh rebuild moves to an epoch above every
 *   epoch on the log, so it can never reuse an epoch its lost predecessor
 *   already delivered under. Without the gate, an epoch bump whose Pi
 *   envelopes never reached the log could still deliver relay messages; a
 *   later fresh rebuild would reuse that epoch from producer seq 0 and the
 *   target inbox would drop the new messages as in-epoch duplicates.
 * - `appended` / `duplicate` (204: an in-epoch retry of a POST whose ack was
 *   lost) — the row is on the target: delete it.
 * - `producer-gap`, expected above ours — our earlier POSTs landed and their
 *   acks were lost: delete this producer's rows below the expected seq.
 * - `producer-gap`, expected below ours — the server forgot this producer
 *   (producer-state TTL): renumber this producer's pending rows from the
 *   expected seq in the same epoch. The receiver deduplicates by message id.
 * - `fenced` — a writer with a higher epoch owns this producer: a zombie of
 *   this entity. Stop relaying for good and report it through `onFenced`.
 * - `retryable`, network errors — back off and `armWake`.
 * - `not-found` — the target stream does not exist yet: create it, retry.
 */

import { DurableStreamLogError, type AppendOutcome, type DurableStreamLog } from '../streams/log.ts';
import type { FencedSqliteDatabase } from './fenced-sqlite-database.ts';

export type RelayDrainResult =
	| { readonly status: 'idle' | 'published' }
	/** Rows remain whose Pi commit is not on the log yet. */
	| { readonly status: 'gated' }
	| { readonly status: 'backoff'; readonly retryAt: number; readonly error: unknown }
	| { readonly status: 'fenced'; readonly target: string; readonly currentEpoch: number }
	| { readonly status: 'closed' };

export interface RelayRow {
	readonly id: number;
	readonly seq: number;
	readonly target: string;
	readonly body: string;
	readonly producerId: string;
	readonly producerEpoch: number;
	readonly producerSeq: number;
}

export interface RelayDrainerOptions {
	readonly database: FencedSqliteDatabase;
	readonly log: DurableStreamLog;
	readonly now?: () => number;
	/** When a backed-off drain should run again. Without it, a timer is used. */
	readonly armWake?: (atMs: number) => void | Promise<void>;
	/** A newer writer owns one of this entity's relay producers. */
	readonly onFenced: (target: string, epoch: number) => void;
	readonly onReport?: (error: unknown) => void;
	readonly backoff?: { readonly initialMs?: number; readonly maxMs?: number };
}

type RowShape = {
	readonly id: number | bigint;
	readonly seq: number | bigint;
	readonly target: string;
	readonly body: string;
	readonly producer_id: string;
	readonly producer_epoch: number | bigint;
	readonly producer_seq: number | bigint;
};

function toRow(row: RowShape): RelayRow {
	return {
		id: Number(row.id),
		seq: Number(row.seq),
		target: row.target,
		body: row.body,
		producerId: row.producer_id,
		producerEpoch: Number(row.producer_epoch),
		producerSeq: Number(row.producer_seq),
	};
}

const HEAD_SQL = `SELECT id, seq, target, body, producer_id, producer_epoch, producer_seq
	FROM flue_relay_outbox ORDER BY id LIMIT 1`;

export class RelayDrainer {
	private readonly db: FencedSqliteDatabase;
	private readonly log: DurableStreamLog;
	private readonly now: () => number;
	private readonly armWake: RelayDrainerOptions['armWake'];
	private readonly onFenced: RelayDrainerOptions['onFenced'];
	private readonly onReport: (error: unknown) => void;
	private readonly initialBackoffMs: number;
	private readonly maxBackoffMs: number;

	private chain: Promise<unknown> = Promise.resolve();
	private queued: Promise<RelayDrainResult> | undefined;
	private attempts = 0;
	private wakeTimer: ReturnType<typeof setTimeout> | undefined;
	private fence: { readonly target: string; readonly epoch: number } | undefined;
	private closed = false;
	private readonly abort = new AbortController();

	constructor(options: RelayDrainerOptions) {
		this.db = options.database;
		this.log = options.log;
		this.now = options.now ?? Date.now;
		this.armWake = options.armWake;
		this.onFenced = options.onFenced;
		this.onReport = options.onReport ?? (() => {});
		this.initialBackoffMs = options.backoff?.initialMs ?? 250;
		this.maxBackoffMs = options.backoff?.maxMs ?? 30_000;
	}

	/** Rows still to post, oldest first. */
	pendingRows(): RelayRow[] {
		return this.db
			.prepare(
				`SELECT id, seq, target, body, producer_id, producer_epoch, producer_seq
				FROM flue_relay_outbox ORDER BY id`,
			)
			.all<RowShape>()
			.map(toRow);
	}

	pending(): number {
		const row = this.db.prepare('SELECT COUNT(*) AS n FROM flue_relay_outbox').get<{ n: number | bigint }>();
		return Number(row?.n ?? 0);
	}

	get fenced(): { readonly target: string; readonly epoch: number } | undefined {
		return this.fence;
	}

	/** One drain pass after any running one; a pass that has not started yet is shared. */
	drain(signal?: AbortSignal): Promise<RelayDrainResult> {
		if (this.queued) return this.queued;
		const pass = this.chain.then(() => {
			this.queued = undefined;
			return this.drainOnce(signal);
		});
		this.queued = pass;
		this.chain = pass.catch(() => {});
		return pass;
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
		this.abort.abort();
		await this.chain;
	}

	/** Whether the Pi commit `seq` is on the canonical log (no outbox row at or below it). */
	private published(seq: number): boolean {
		return this.db.prepare('SELECT seq FROM flue_pi_outbox WHERE seq <= ? LIMIT 1').get(seq) === undefined;
	}

	private async drainOnce(external: AbortSignal | undefined): Promise<RelayDrainResult> {
		const signal = external ? AbortSignal.any([external, this.abort.signal]) : this.abort.signal;
		let published = false;
		while (true) {
			if (this.fence) return { status: 'fenced', target: this.fence.target, currentEpoch: this.fence.epoch };
			if (this.closed || signal.aborted) return { status: 'closed' };
			const head = this.db.prepare(HEAD_SQL).get<RowShape>();
			if (!head) {
				this.attempts = 0;
				return { status: published ? 'published' : 'idle' };
			}
			const row = toRow(head);
			if (!this.published(row.seq)) return { status: 'gated' };
			let outcome: AppendOutcome;
			try {
				outcome = await this.log.append(
					row.target,
					{
						messages: [JSON.parse(row.body) as unknown],
						producer: { id: row.producerId, epoch: row.producerEpoch, seq: row.producerSeq },
					},
					signal,
				);
			} catch (error) {
				if (this.closed || signal.aborted) return { status: 'closed' };
				if (error instanceof DurableStreamLogError && error.code === 'not-found') {
					try {
						await this.log.ensure(row.target, signal);
						continue;
					} catch (ensureError) {
						return this.backoff(ensureError);
					}
				}
				if (!(error instanceof DurableStreamLogError && error.retryable)) this.onReport(error);
				return this.backoff(error);
			}
			if (this.closed) return { status: 'closed' };
			switch (outcome.status) {
				case 'appended':
				case 'duplicate':
					await this.db.transactionUnarmed(() => this.deleteRow(row.id));
					this.attempts = 0;
					published = true;
					continue;
				case 'producer-gap': {
					const expected = outcome.expectedSeq;
					if (expected > row.producerSeq) {
						await this.db.transactionUnarmed(() => {
							this.db
								.prepare(
									`DELETE FROM flue_relay_outbox
									WHERE target = ? AND producer_id = ? AND producer_epoch = ? AND producer_seq < ?`,
								)
								.run(row.target, row.producerId, row.producerEpoch, expected);
						});
						published = true;
						continue;
					}
					this.onReport(
						new Error(
							`[flue] Relay target "${row.target}" expects producer seq ${expected} ` +
								`below ours (${row.producerSeq}); renumbering producer "${row.producerId}".`,
						),
					);
					await this.db.transactionUnarmed(() => this.renumberSync(row, expected));
					continue;
				}
				case 'stream-seq-conflict':
					// Relay appends carry no Stream-Seq; a server answering this is outside the protocol.
					this.onReport(new Error(`[flue] Relay target "${row.target}" answered a Stream-Seq conflict.`));
					return this.backoff(new Error('unexpected stream-seq conflict'));
				case 'fenced':
					return this.poison(row.target, outcome.currentEpoch);
				case 'retryable':
					return this.backoff(outcome.error);
			}
		}
	}

	/** Renumber this producer's pending rows (same epoch) from `from`, in id order. */
	private renumberSync(row: RelayRow, from: number): void {
		const rows = this.db
			.prepare(
				`SELECT id FROM flue_relay_outbox
				WHERE target = ? AND producer_id = ? AND producer_epoch = ? ORDER BY id`,
			)
			.all<{ id: number | bigint }>(row.target, row.producerId, row.producerEpoch);
		const update = this.db.prepare('UPDATE flue_relay_outbox SET producer_seq = ? WHERE id = ?');
		rows.forEach((pending, index) => {
			update.run(from + index, Number(pending.id));
		});
		this.db
			.prepare(
				`UPDATE flue_relay_producer SET next_producer_seq = ?
				WHERE target = ? AND producer_id = ? AND epoch = ?`,
			)
			.run(from + rows.length, row.target, row.producerId, row.producerEpoch);
	}

	private deleteRow(id: number): void {
		this.db.prepare('DELETE FROM flue_relay_outbox WHERE id = ?').run(id);
	}

	private poison(target: string, epoch: number): RelayDrainResult {
		if (!this.fence) {
			this.fence = { target, epoch };
			try {
				this.onFenced(target, epoch);
			} catch (error) {
				this.onReport(error);
			}
		}
		return { status: 'fenced', target: this.fence.target, currentEpoch: this.fence.epoch };
	}

	private backoff(error: unknown): RelayDrainResult {
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
