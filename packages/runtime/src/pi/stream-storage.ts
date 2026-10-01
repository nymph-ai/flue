/**
 * `StreamStorage` — Pi Durable's `Storage` over the canonical Durable Streams
 * log (PI_UPGRADE_PLAN.md §2.3, §2.4).
 *
 * The log is the truth; Pi's `SqliteStorage` is a materialized index of it,
 * living in the same SQLite database as the commit outbox:
 *
 * - `commit` is locally atomic: Pi's index rows, the outbox row carrying the
 *   exact `StorageWrite[]`, and any relay rows commit in one SQLite
 *   transaction (`FencedSqliteDatabase`). It resolves with the index's `Seq`
 *   and never fails because publishing failed (pico-v5 §Storage: after
 *   admission only unknown failures are fatal) — publishing is the outbox's.
 * - Every read is the index's.
 * - `rebuild()` drops the index and replays the log from the start, asserting
 *   each replayed seq equals the envelope's; commits still in the outbox are
 *   replayed after it, so nothing local is lost.
 * - The storage incarnation (a ULID minted with the log's first commit, carried
 *   by every envelope) detects a log that was deleted and recreated, or a
 *   database that belongs to another log.
 * - A newer writer (403) or a log holding a different commit at one of our
 *   seqs poisons the storage: `onFenced` fires, draining stops, and every
 *   later `commit` is rejected before any durable effect.
 */

import type { Context, JsonValue } from '@earendil-works/chord';
import {
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	type DocumentAddress,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Id,
	type Page,
	type Seq,
	type Storage,
	StorageRejected,
	type StorageWrite,
	type StoredDocument,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskQuery,
	type TaskRecord,
} from '@earendil-works/pi-durable';
import {
	SQLITE_MIGRATIONS,
	type SqliteDatabase,
	SqliteStorage,
} from '@earendil-works/pi-durable/storage/sqlite';
import { ulid } from 'ulidx';
import type { DurableStreamLog } from '../streams/log.ts';
import { STREAM_START, type StreamOffset } from '../streams/offset.ts';
import { type EntityAddress, entityProducerName, entityStreamRoot } from './a2a-entries.ts';
import {
	CommitAssembler,
	createCommitEnvelope,
	decodeCommitEnvelope,
	type PiCommitEnvelope,
} from './commit-envelope.ts';
import {
	type DrainResult,
	ensureCommitOutboxSchema,
	type FenceReason,
	SqliteCommitOutbox,
} from './commit-outbox.ts';
import { FencedSqliteDatabase, TransactionShapeError } from './fenced-sqlite-database.ts';
import { RelayDrainer, type RelayDrainResult } from './relay-drainer.ts';

export interface StreamStorageOptions {
	/**
	 * The SQLite database holding the index and the outbox. DO:
	 * `doSqliteDatabase(ctx.storage)`; Node: `openNodeSqliteDatabase(file)`.
	 * StreamStorage owns it and closes it on `close()`.
	 */
	readonly database: SqliteDatabase;
	readonly log: DurableStreamLog;
	/** This storage's entity: names the log and addresses relay rows. */
	readonly entity: EntityAddress;
	/** Log path relative to the log's base URL. Default `flue/v1/{type}/{id}/pi`. */
	readonly path?: string;
	/** `Producer-Id`. Default `{type}/{id}/pi`. */
	readonly producerId?: string;
	/**
	 * `async` (default): `commit` resolves once the local transaction commits and
	 * publishing continues in the background. `await`: `commit` also waits, up to
	 * `publishTimeoutMs`, for its envelope to be on the log — and still resolves
	 * if it is not.
	 */
	readonly publish?: 'async' | 'await';
	/** `publish: "await"` deadline (default 10 s). */
	readonly publishTimeoutMs?: number;
	/** Another writer owns the log (or diverged from it): poison the host. */
	readonly onFenced: (epoch: number, reason: FenceReason) => void;
	/** Background failures (publish errors, backoffs). */
	readonly onReport?: (error: unknown) => void;
	/** When a backed-off drain should run again (DO alarm). Default: an in-process timer. */
	readonly armWake?: (atMs: number) => void | Promise<void>;
	/** Split envelopes above this size into parts. Default 1 MiB. */
	readonly maxMessageBytes?: number;
	readonly now?: () => number;
	/** Mints the storage incarnation of a new log. Default: a ULID. */
	readonly newIncarnation?: () => string;
	readonly backoff?: { readonly initialMs?: number; readonly maxMs?: number };
	/**
	 * Post relay rows (A2A sends, publishes) after their commit is on the log.
	 * Default `true`; `false` leaves them in `flue_relay_outbox` (tests of the
	 * Pi log alone).
	 */
	readonly relay?: boolean;
}

/** Advisory key/value cursors kept beside the index (`flue_entity_cursors`). */
export interface EntityCursorStore {
	get(key: string): string | undefined;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/** The log and this database do not belong together. */
export class StreamStorageIncarnationError extends Error {
	constructor(path: string, message: string) {
		super(`[flue] Pi log "${path}": ${message}`);
		this.name = 'StreamStorageIncarnationError';
	}
}

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** Pi's own tables, from its migrations: what `rebuild()` drops. */
const PI_TABLES: readonly string[] = [
	...new Set(
		SQLITE_MIGRATIONS.flatMap((migration) =>
			migration.statements.flatMap((statement) => {
				const match = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/i.exec(statement);
				return match?.[1] ? [match[1]] : [];
			}),
		),
	),
	'durable_schema',
];

const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;

interface LogReplay {
	readonly envelopes: PiCommitEnvelope[];
	/** Pi seq → the offset after the read batch that completed it. */
	readonly offsets: Map<number, string>;
	readonly tail: StreamOffset;
}

export class StreamStorage implements Storage {
	readonly path: string;
	readonly producerId: string;
	readonly outbox: SqliteCommitOutbox;
	/** Posts A2A sends and publishes once their commit is on the log. */
	readonly relay: RelayDrainer;
	readonly cursors: EntityCursorStore;

	private readonly db: FencedSqliteDatabase;
	private readonly log: DurableStreamLog;
	private readonly options: StreamStorageOptions;
	private readonly now: () => number;
	private readonly publish: 'async' | 'await';
	private readonly report: (error: unknown) => void;
	private readonly relayEnabled: boolean;
	private index: SqliteStorage;
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	private poisoned: Error | undefined;

	private constructor(
		options: StreamStorageOptions,
		db: FencedSqliteDatabase,
		index: SqliteStorage,
	) {
		this.options = options;
		this.db = db;
		this.index = index;
		this.log = options.log;
		this.path = options.path ?? `${entityStreamRoot(options.entity)}/pi`;
		this.producerId = options.producerId ?? `${entityProducerName(options.entity)}/pi`;
		this.now = options.now ?? Date.now;
		this.publish = options.publish ?? 'async';
		this.report = options.onReport ?? (() => {});
		this.outbox = new SqliteCommitOutbox({
			database: db,
			log: options.log,
			path: this.path,
			entity: options.entity,
			now: this.now,
			onFenced: (epoch, reason) => {
				this.poisoned ??= new StorageRejected(
					`[flue] Pi log "${this.path}" is fenced (${reason}, epoch ${epoch}); this storage accepts no more commits.`,
				);
				options.onFenced(epoch, reason);
			},
			onReport: this.report,
			...(options.maxMessageBytes === undefined
				? {}
				: { maxMessageBytes: options.maxMessageBytes }),
			...(options.armWake === undefined ? {} : { armWake: options.armWake }),
			...(options.backoff === undefined ? {} : { backoff: options.backoff }),
		});
		this.relayEnabled = options.relay ?? true;
		this.relay = new RelayDrainer({
			database: db,
			log: options.log,
			now: this.now,
			onFenced: (target, epoch) => {
				this.poisoned ??= new StorageRejected(
					`[flue] Relay target "${target}" is fenced (epoch ${epoch}): a newer writer owns this entity; this storage accepts no more commits.`,
				);
				options.onFenced(epoch, 'relay');
			},
			onReport: this.report,
			...(options.armWake === undefined ? {} : { armWake: options.armWake }),
			...(options.backoff === undefined ? {} : { backoff: options.backoff }),
		});
		this.cursors = {
			get: (key) =>
				db
					.prepare('SELECT value FROM flue_entity_cursors WHERE key = ?')
					.get<{ value: string }>(key)?.value,
			set: async (key, value) => {
				await db.transactionUnarmed(() =>
					db
						.prepare(
							'INSERT INTO flue_entity_cursors (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
						)
						.run(key, value),
				);
			},
			delete: async (key) => {
				await db.transactionUnarmed(() =>
					db.prepare('DELETE FROM flue_entity_cursors WHERE key = ?').run(key),
				);
			},
		};
		db.setCommitHook((seq, writes) => {
			const producer = this.outbox.requireProducer();
			this.outbox.enqueueSync(
				createCommitEnvelope({
					storage: producer.incarnation,
					seq,
					epoch: producer.epoch,
					at: this.now(),
					writes,
				}),
			);
		});
	}

	/** Migrations → rebuild if the index is empty and the log is not → drain. */
	static async open(options: StreamStorageOptions, context: Context): Promise<StreamStorage> {
		const db =
			options.database instanceof FencedSqliteDatabase
				? options.database
				: new FencedSqliteDatabase(options.database);
		let storage: StreamStorage | undefined;
		try {
			db.setIndexReady(false);
			await db.transactionUnarmed(() => ensureCommitOutboxSchema(db));
			const index = await SqliteStorage.open(indexView(db));
			db.setIndexReady(true);
			storage = new StreamStorage(options, db, index);
			await storage.initialize(context);
			return storage;
		} catch (error) {
			await storage?.outbox.close().catch(() => {});
			try {
				await db.close();
			} catch {
				// Preserve the open failure.
			}
			throw error;
		}
	}

	/** The storage incarnation every envelope of this log carries. */
	get incarnation(): string {
		return this.outbox.requireProducer().incarnation;
	}

	/** Why this storage stopped accepting commits, if it did. */
	get fenced(): Error | undefined {
		return this.poisoned;
	}

	/**
	 * Publish what is pending now (the host's alarm / wake entry point): the
	 * Pi outbox, then the relay rows whose commits it put on the log.
	 */
	async drain(signal?: AbortSignal): Promise<DrainResult> {
		if (this.closed) return { status: 'closed' };
		const result = await this.outbox.drain(signal);
		if (this.relayEnabled && !this.closed) await this.relay.drain(signal);
		return result;
	}

	/** Post the relay rows whose commits are on the log. */
	drainRelay(signal?: AbortSignal): Promise<RelayDrainResult> {
		if (this.closed) return Promise.resolve({ status: 'closed' });
		return this.relay.drain(signal);
	}

	// ─── Storage: commit ─────────────────────────────────────────────────────

	async commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
		const seq = await this.serialize(async () => {
			this.assertOpen();
			if (this.poisoned) throw this.poisoned;
			this.db.armCommit(writes);
			let committed: Seq | undefined;
			try {
				committed = await this.index.commit(writes, context);
			} finally {
				const arm = this.db.disarm();
				if (committed !== undefined && (!arm.consumed || arm.seq !== committed)) {
					// The index committed without (or apart from) its outbox row: the
					// log would silently miss this seq. Nothing is safe after that.
					this.poisoned = new TransactionShapeError(
						`commit resolved seq ${committed} but the armed transaction ${
							arm.consumed ? `committed seq ${arm.seq}` : 'never ran'
						}.`,
					);
				}
			}
			if (this.poisoned instanceof TransactionShapeError) throw this.poisoned;
			if (committed === undefined)
				throw new Error('[flue] SqliteStorage.commit resolved without a Seq.');
			return committed;
		});
		if (this.publish === 'await') {
			await this.outbox
				.waitForPublished(
					seq,
					this.now() + (this.options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS),
				)
				.catch((error) => this.report(error));
			if (this.relayEnabled && !this.closed)
				await this.relay.drain().catch((error) => this.report(error));
		} else {
			this.kick();
		}
		return seq;
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.index.mintId<I>();
	}

	// ─── Storage: reads (the index) ──────────────────────────────────────────

	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		return this.index.conversation(id, context);
	}

	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.index.scanConversations(query, limit, cursor, context);
	}

	entry(
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		...args: [EntryId, Context] | [ConversationId, EntryId, Context]
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		return args.length === 2
			? this.index.entry(args[0], args[1])
			: this.index.entry(args[0], args[1], args[2]);
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.index.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context);
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.index.scanEntries(query, limit, cursor, context);
	}

	task(id: TaskId, context: Context): Promise<StoredTask | undefined> {
		return this.index.task(id, context);
	}

	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		return this.index.scanTasks(query, limit, cursor, context);
	}

	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		return this.index.submission(id, context);
	}

	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.index.scanSubmissions(query, limit, cursor, context);
	}

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.index.submissionByRequest(conversationId, requestId, context);
	}

	findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		context: Context,
	): Promise<DocumentRecord | undefined> {
		return this.index.findDocument(address, at, context);
	}

	document(
		id: DocumentId,
		at: DocumentPoint,
		context: Context,
	): Promise<StoredDocument | undefined> {
		return this.index.document(id, at, context);
	}

	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.index.scanDocuments(query, limit, cursor, context);
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	async close(context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.queue.catch(() => {});
		await this.outbox.close();
		await this.relay.close();
		try {
			await this.index.close(context);
		} finally {
			await this.db.close();
		}
	}

	/** Drop the index and replay the log; asserts replayed seq === envelope.seq for every commit. */
	rebuild(context: Context): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			await this.rebuildLocked(context);
		});
	}

	// ─── Internals ───────────────────────────────────────────────────────────

	private async initialize(context: Context): Promise<void> {
		await this.log.ensure(this.path);
		const producer = this.outbox.producer();
		const lastSeq = this.lastIndexedSeq();
		const first = await this.readFirstEnvelope();
		if (!producer) {
			if (lastSeq > 0) {
				throw new StreamStorageIncarnationError(
					this.path,
					`the database holds ${lastSeq} Pi commits but no Flue outbox; refusing to adopt it.`,
				);
			}
			const incarnation = first?.storage ?? (this.options.newIncarnation ?? ulid)();
			await this.db.transactionUnarmed(() =>
				this.outbox.initProducerSync({
					producerId: this.producerId,
					epoch: 0,
					nextProducerSeq: 0,
					publishedSeq: 0,
					publishedOffset: undefined,
					incarnation,
				}),
			);
			// A fresh index over a log that already holds commits.
			if (first) await this.rebuildLocked(context);
		} else {
			if (producer.producerId !== this.producerId) {
				throw new StreamStorageIncarnationError(
					this.path,
					`the database publishes as producer "${producer.producerId}", not "${this.producerId}".`,
				);
			}
			if (first && first.storage !== producer.incarnation) {
				throw new StreamStorageIncarnationError(
					this.path,
					`the log belongs to storage incarnation ${first.storage}, this database to ${producer.incarnation}.`,
				);
			}
			if (!first && producer.publishedSeq > 0) {
				throw new StreamStorageIncarnationError(
					this.path,
					`the log is empty but ${producer.publishedSeq} commits were published to it: it was recreated.`,
				);
			}
			const pending = this.outbox.pendingRows();
			if (lastSeq === 0 && (producer.publishedSeq > 0 || pending.length > 0)) {
				// The index (a cache) was discarded; the log and outbox were not.
				await this.rebuildLocked(context);
			} else {
				const covered = Math.max(producer.publishedSeq, pending.at(-1)?.seq ?? 0);
				if (covered !== lastSeq) {
					throw new TransactionShapeError(
						`the index holds ${lastSeq} commits but the outbox accounts for ${covered}.`,
					);
				}
			}
		}
		if (this.publish === 'await') {
			const through = this.lastIndexedSeq();
			if (through > 0) {
				await this.outbox.waitForPublished(
					through,
					this.now() + (this.options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS),
				);
			}
			if (this.relayEnabled) await this.relay.drain().catch((error) => this.report(error));
		} else {
			this.kick();
		}
	}

	private async rebuildLocked(context: Context): Promise<void> {
		const producer = this.outbox.requireProducer();
		const replay = await this.readLog(producer.incarnation);
		const logged = replay.envelopes.length;
		if (producer.publishedSeq > logged) {
			throw new StreamStorageIncarnationError(
				this.path,
				`the log ends at seq ${logged} but ${producer.publishedSeq} commits were published to it.`,
			);
		}
		// Local commits not on the log yet are replayed after it, from the outbox.
		const local = this.outbox
			.pendingRows()
			.filter((row) => row.seq > logged)
			.map((row) => decodeCommitEnvelope(row.body));
		local.forEach((envelope, index) => {
			if (envelope.seq !== logged + index + 1) {
				throw new StreamStorageIncarnationError(
					this.path,
					`the log ends at seq ${logged} but the outbox resumes at seq ${envelope.seq}.`,
				);
			}
		});

		this.db.setIndexReady(false);
		await this.db.transactionUnarmed(() => {
			for (const table of PI_TABLES) this.db.exec(`DROP TABLE IF EXISTS "${table}"`);
		});
		this.index = await SqliteStorage.open(indexView(this.db));
		this.db.setIndexReady(true);

		for (const envelope of [...replay.envelopes, ...local]) {
			this.db.armReplay(envelope.seq);
			let seq: Seq;
			try {
				seq = await this.index.commit(envelope.writes, context);
			} catch (error) {
				this.db.disarm();
				throw error;
			}
			const arm = this.db.disarm();
			if (!arm.consumed || arm.seq !== seq) {
				throw new TransactionShapeError(
					`replayed seq ${envelope.seq} committed outside its transaction.`,
				);
			}
			if (seq !== envelope.seq) {
				throw new Error(
					`[flue] Pi log replay diverged: envelope seq ${envelope.seq} replayed as seq ${seq}.`,
				);
			}
		}

		// A rebuilt index publishes under a new epoch, above every epoch on the
		// log, so none of its sends can pass for an in-epoch retry of an earlier
		// writer; Stream-Seq deduplicates whatever pending row already landed.
		const logEpoch = replay.envelopes.reduce((max, envelope) => Math.max(max, envelope.epoch), 0);
		const epoch = Math.max(producer.epoch, logEpoch) + 1;
		await this.db.transactionUnarmed(() => {
			this.outbox.startEpochSync(epoch);
			this.outbox.recordReplaySync(logged, replay.tail, replay.offsets);
		});
	}

	/** Every envelope on the log, in order, checked for incarnation and seq continuity. */
	private async readLog(incarnation: string): Promise<LogReplay> {
		const envelopes: PiCommitEnvelope[] = [];
		const offsets = new Map<number, string>();
		const assembler = new CommitAssembler();
		let offset: StreamOffset = STREAM_START;
		while (true) {
			const batch = await this.log.read(this.path, offset);
			let lastInBatch: number | undefined;
			for (const message of batch.messages) {
				const envelope = assembler.accept(message);
				if (!envelope) continue;
				if (envelope.storage !== incarnation) {
					throw new StreamStorageIncarnationError(
						this.path,
						`seq ${envelope.seq} belongs to storage incarnation ${envelope.storage}, not ${incarnation}.`,
					);
				}
				if (envelope.seq !== envelopes.length + 1) {
					throw new Error(
						`[flue] Pi log "${this.path}" is not contiguous: seq ${envelope.seq} follows ${envelopes.length}.`,
					);
				}
				envelopes.push(envelope);
				lastInBatch = envelope.seq;
			}
			if (lastInBatch !== undefined && !assembler.pending)
				offsets.set(lastInBatch, batch.nextOffset);
			offset = batch.nextOffset;
			if (batch.upToDate || batch.messages.length === 0) break;
		}
		if (assembler.pending) throw new Error(`[flue] Pi log "${this.path}" ends inside a commit.`);
		return { envelopes, offsets, tail: offset };
	}

	private async readFirstEnvelope(): Promise<PiCommitEnvelope | undefined> {
		const assembler = new CommitAssembler();
		let offset: StreamOffset = STREAM_START;
		while (true) {
			const batch = await this.log.read(this.path, offset);
			for (const message of batch.messages) {
				const envelope = assembler.accept(message);
				if (envelope) return envelope;
			}
			offset = batch.nextOffset;
			if (batch.upToDate || batch.messages.length === 0) return undefined;
		}
	}

	private lastIndexedSeq(): number {
		return (this.db.nextSeq() ?? 1) - 1;
	}

	private kick(): void {
		if (this.closed || this.poisoned) return;
		this.outbox
			.drain()
			.then(() => (this.relayEnabled && !this.closed ? this.relay.drain() : undefined))
			.catch((error) => this.report(error));
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('StreamStorage is closed');
	}

	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work, work);
		this.queue = run.catch(() => {});
		return run;
	}
}

/**
 * What `SqliteStorage` sees: the fenced facade, except that closing it is
 * StreamStorage's decision (a rebuild discards one index and opens another).
 */
function indexView(db: FencedSqliteDatabase): SqliteDatabase {
	return {
		exec(sql: string): void {
			db.exec(sql);
		},
		prepare(sql: string) {
			return db.prepare(sql);
		},
		transaction<T>(callback: () => T): T | Promise<T> {
			return db.transaction(callback);
		},
		close(): void {},
	};
}
