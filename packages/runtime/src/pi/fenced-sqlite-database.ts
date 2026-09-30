/**
 * A Pi `SqliteDatabase` facade that makes one Pi commit and its outbox row one
 * SQLite transaction (PI_UPGRADE_PLAN.md §2.3, §2.4 step 1).
 *
 * It relies on the shape of `SqliteStorage` in `@earendil-works/pi-durable`
 * 0.99.2 (`storage/sqlite/storage.ts`, verified against the v0.99.2 tag):
 *
 * - `SqliteStorage.open(db)` runs `applySqliteMigrations(db)`: exactly one
 *   `db.transaction()` whose callback returns `undefined`.
 * - `commit(writes)` runs `prepareDocumentActions` and `candidateNextId`
 *   outside any transaction (either may throw), then exactly one
 *   `db.transaction(cb)`, invoked synchronously before the method's first
 *   `await`. `cb` reads `durable_metadata.next_seq`, applies the writes, stores
 *   `next_seq + 1` and returns the committed `Seq` (a plain number).
 * - `mintId()` and every read run no transaction.
 *
 * The facade does not trust that shape; it checks it on every transaction:
 *
 * - An armed transaction (the one `armCommit` / `armReplay` expects) must
 *   return a safe integer equal to `next_seq` before the callback, and leave
 *   `next_seq` one higher. Otherwise it throws {@link TransactionShapeError}
 *   inside the transaction, so the commit rolls back with nothing durable.
 * - An unarmed transaction must not move `next_seq`: a commit that would
 *   bypass the outbox rolls back loudly instead of silently diverging the log.
 * - `disarm()` reports whether the arm was consumed; a commit that resolved
 *   without consuming it is a shape change the caller turns into a fatal error.
 *
 * `durable_metadata` is read only once {@link setIndexReady} says the Pi
 * schema exists (before that, the only transaction is the migration).
 */

import type { StorageWrite } from '@earendil-works/pi-durable';
import type {
	SqliteDatabase,
	SqliteStatement,
} from '@earendil-works/pi-durable/storage/sqlite';

/** Runs inside the armed commit's transaction, after Pi's writes, with the committed seq. */
export type CommitHook = (seq: number, writes: readonly StorageWrite[]) => void;

/** `SqliteStorage` no longer commits the way this facade was built for. */
export class TransactionShapeError extends Error {
	constructor(message: string) {
		super(
			`[flue] SqliteStorage transaction shape changed: ${message} ` +
				'Re-verify pi-durable storage/sqlite/storage.ts before bumping Pi (PI_UPGRADE_PLAN.md risk 1).',
		);
		this.name = 'TransactionShapeError';
	}
}

type Arm =
	| { readonly kind: 'commit'; readonly writes: readonly StorageWrite[]; consumed: boolean; seq?: number }
	| { readonly kind: 'replay'; readonly expectedSeq: number; consumed: boolean; seq?: number };

type MetadataRow = { readonly next_seq: number | bigint };

export interface DisarmResult {
	/** Whether a transaction consumed the arm. */
	readonly consumed: boolean;
	/** The seq that transaction committed. */
	readonly seq?: number;
}

export class FencedSqliteDatabase implements SqliteDatabase {
	readonly inner: SqliteDatabase;
	private arm: Arm | undefined;
	private hook: CommitHook | undefined;
	private indexReady = false;
	private metadataStatement: SqliteStatement | undefined;

	constructor(inner: SqliteDatabase) {
		this.inner = inner;
	}

	exec(sql: string): void {
		this.inner.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return this.inner.prepare(sql);
	}

	/** Installed once by the owning `StreamStorage`: writes the outbox and relay rows. */
	setCommitHook(hook: CommitHook): void {
		this.hook = hook;
	}

	/** Whether Pi's `durable_metadata` table exists (false before migrations and while rebuilding). */
	setIndexReady(ready: boolean): void {
		this.indexReady = ready;
		this.metadataStatement = undefined;
	}

	/** Expect the next `transaction()` to be the Pi commit of `writes`. */
	armCommit(writes: readonly StorageWrite[]): void {
		this.assertUnarmed();
		this.arm = { kind: 'commit', writes, consumed: false };
	}

	/** Expect the next `transaction()` to be a replayed Pi commit that must return `expectedSeq`; no outbox row. */
	armReplay(expectedSeq: number): void {
		this.assertUnarmed();
		this.arm = { kind: 'replay', expectedSeq, consumed: false };
	}

	disarm(): DisarmResult {
		const arm = this.arm;
		this.arm = undefined;
		if (!arm) return { consumed: false };
		return arm.seq === undefined ? { consumed: arm.consumed } : { consumed: arm.consumed, seq: arm.seq };
	}

	/** The `SqliteDatabase` entry point `SqliteStorage` calls. */
	transaction<T>(callback: () => T): T | Promise<T> {
		const arm = this.arm;
		if (arm && !arm.consumed) {
			arm.consumed = true;
			return this.inner.transaction(() => this.runArmed(arm, callback));
		}
		return this.inner.transaction(() => this.runUnarmed(callback));
	}

	/**
	 * A transaction for Flue's own bookkeeping (outbox acks, schema, producer
	 * state). It never consumes an arm, but is held to the unarmed rule.
	 */
	transactionUnarmed<T>(callback: () => T): T | Promise<T> {
		return this.inner.transaction(() => this.runUnarmed(callback));
	}

	close(): void | Promise<void> {
		return this.inner.close();
	}

	/** `durable_metadata.next_seq`, or `undefined` while the Pi schema is not ready. */
	nextSeq(): number | undefined {
		if (!this.indexReady) return undefined;
		this.metadataStatement ??= this.inner.prepare(
			'SELECT next_seq FROM durable_metadata WHERE singleton = 1',
		);
		const row = this.metadataStatement.get<MetadataRow>();
		if (row === undefined) throw new TransactionShapeError('durable_metadata has no singleton row.');
		return Number(row.next_seq);
	}

	private assertUnarmed(): void {
		if (this.arm) {
			throw new Error('[flue] FencedSqliteDatabase is already armed; commits must be serialized.');
		}
	}

	private runArmed<T>(arm: Arm, callback: () => T): T {
		const before = this.nextSeq();
		const result = callback();
		if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1) {
			throw new TransactionShapeError(
				`the commit transaction returned ${describe(result)}, not a Seq.`,
			);
		}
		if (before !== undefined && result !== before) {
			throw new TransactionShapeError(
				`the commit transaction returned seq ${result} but durable_metadata.next_seq was ${before}.`,
			);
		}
		const after = this.nextSeq();
		if (after !== undefined && after !== result + 1) {
			throw new TransactionShapeError(
				`after committing seq ${result}, durable_metadata.next_seq is ${after}, not ${result + 1}.`,
			);
		}
		if (arm.kind === 'replay') {
			if (result !== arm.expectedSeq) {
				throw new Error(
					`[flue] Pi log replay diverged: envelope seq ${arm.expectedSeq} replayed as seq ${result}.`,
				);
			}
		} else {
			if (!this.hook) throw new Error('[flue] FencedSqliteDatabase has no commit hook installed.');
			this.hook(result, arm.writes);
		}
		arm.seq = result;
		return result as T;
	}

	private runUnarmed<T>(callback: () => T): T {
		const before = this.nextSeq();
		const result = callback();
		if (before !== undefined) {
			const after = this.nextSeq();
			if (after !== before) {
				throw new TransactionShapeError(
					`an unexpected transaction moved durable_metadata.next_seq from ${before} to ${after} ` +
						'without an outbox row.',
				);
			}
		}
		return result;
	}
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'object' || typeof value === 'function') {
		return typeof (value as { then?: unknown }).then === 'function' ? 'a promise' : `a ${typeof value}`;
	}
	return `${typeof value} ${String(value)}`;
}
