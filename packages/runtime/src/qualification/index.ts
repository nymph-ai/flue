/**
 * `@flue/runtime/qualification` — the internals a live qualification of a
 * deployed Flue app needs and no app should: open a Pi log's index by
 * replaying the log into a scratch database, snapshot every Pi read of an
 * index, read raw commit envelopes, and talk to the configured log directly.
 *
 * Nothing here is part of the authoring surface. It exists so a test-only
 * build (`examples/agent-society` with `QUALIFICATION=1`) can prove, against
 * a real deployment, that the log rebuilds the same Pi Durable state the live
 * instance holds (nymph-ai/nymphai #3755).
 */
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { createRegistry, defineDoc, Harness } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { type DurableObjectSqliteStorage, doSqliteDatabase } from '../cloudflare/do-sqlite-database.ts';
import { entityKey, eventsPath, inboxPath, wirePath } from '../entity/paths.ts';
import { type EntityAddress, entityStreamRoot } from '../pi/a2a-entries.ts';
import { CommitAssembler, type PiCommitEnvelope } from '../pi/commit-envelope.ts';
import { snapshotReads } from '../pi/read-snapshot.ts';
import { StreamStorage, type StreamStorageOptions } from '../pi/stream-storage.ts';
import { ElectricDurableStreamLog } from '../streams/electric-log.ts';
import type { AppendOutcome, DurableStreamLog, ProducerClaim } from '../streams/log.ts';
import { STREAM_START, type StreamOffset } from '../streams/offset.ts';

export type { AppendOutcome, DurableStreamLog, EntityAddress, PiCommitEnvelope, ProducerClaim };
export type { StreamStorageOptions };
export type { DurableObjectSqliteStorage };
export {
	CommitAssembler,
	doSqliteDatabase,
	ElectricDurableStreamLog,
	entityKey,
	eventsPath,
	inboxPath,
	snapshotReads,
	StreamStorage,
	wirePath,
};
export { configuredStreams, configuredStreamsLog } from '../runtime/streams-config.ts';

export const qualificationContext: Context = BACKGROUND_CONTEXT;

/** The canonical Pi log of an entity: `flue/v1/{type}/{id}/pi`. */
export function piLogPath(entity: EntityAddress): string {
	return `${entityStreamRoot(entity)}/pi`;
}

/** Every commit envelope on a Pi log, reassembled, in order, with the offset after each read batch. */
export async function readPiLog(
	log: DurableStreamLog,
	path: string,
): Promise<{ readonly envelopes: PiCommitEnvelope[]; readonly tail: string }> {
	const envelopes: PiCommitEnvelope[] = [];
	const assembler = new CommitAssembler();
	let offset: StreamOffset = STREAM_START;
	while (true) {
		const batch = await log.read(path, offset);
		for (const message of batch.messages) {
			const envelope = assembler.accept(message);
			if (envelope) envelopes.push(envelope);
		}
		offset = batch.nextOffset;
		if (batch.upToDate || batch.messages.length === 0) return { envelopes, tail: offset };
	}
}

/** The highest Pi seq an index database holds (`durable_metadata.next_seq - 1`; 0 without an index). */
export function indexedSeq(sql: DurableObjectSqliteStorage['sql']): number {
	try {
		const row = sql.exec('SELECT next_seq FROM durable_metadata WHERE singleton = 1').toArray()[0] as
			| { next_seq?: unknown }
			| undefined;
		const next = Number(row?.next_seq ?? 1);
		return Number.isFinite(next) ? next - 1 : 0;
	} catch {
		return 0;
	}
}

/**
 * Snapshot every Pi read of the index already in a Durable Object's SQLite,
 * through a second, read-only `SqliteStorage` over the same database. The
 * instance's own storage keeps running; nothing is written.
 */
export async function snapshotDurableObjectIndex(
	storage: DurableObjectSqliteStorage,
	lastSeq: number,
): Promise<Record<string, unknown>> {
	const index = await SqliteStorage.open(doSqliteDatabase(storage));
	return snapshotReads(index, lastSeq);
}

/**
 * Rebuild an entity's Pi index from its log alone into `storage` (a scratch
 * Durable Object's SQLite, emptied first by the caller) and snapshot it.
 * Opening a fresh database over a log that holds commits is exactly the
 * rebuild a new Durable Object performs; nothing is appended, so the live
 * writer's producer epoch is untouched.
 */
export async function rebuildAndSnapshot(options: {
	readonly storage: DurableObjectSqliteStorage;
	readonly log: DurableStreamLog;
	readonly entity: EntityAddress;
	readonly lastSeq: number;
}): Promise<{ readonly snapshot: Record<string, unknown>; readonly rebuiltSeq: number }> {
	const fences: string[] = [];
	const rebuilt = await StreamStorage.open(
		{
			database: doSqliteDatabase(options.storage),
			log: options.log,
			entity: options.entity,
			relay: false,
			onFenced: (epoch, reason) => fences.push(`${reason}@${epoch}`),
		},
		qualificationContext,
	);
	try {
		if (fences.length > 0) throw new Error(`rebuild was fenced: ${fences.join(', ')}`);
		const rebuiltSeq = indexedSeq(options.storage.sql);
		return { snapshot: await snapshotReads(rebuilt, options.lastSeq), rebuiltSeq };
	} finally {
		await rebuilt.close(qualificationContext);
	}
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Per-key SHA-256 of a snapshot, and one digest over all of them (keys sorted). */
export async function digestSnapshot(
	snapshot: Record<string, unknown>,
): Promise<{ readonly digest: string; readonly keys: Record<string, string> }> {
	const keys: Record<string, string> = {};
	for (const key of Object.keys(snapshot).sort()) {
		keys[key] = await sha256(JSON.stringify(snapshot[key]) ?? 'undefined');
	}
	return { digest: await sha256(JSON.stringify(keys)), keys };
}

/** The keys whose digests differ (or exist on one side only). */
export function diffDigests(
	a: Readonly<Record<string, string>>,
	b: Readonly<Record<string, string>>,
): string[] {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].filter((key) => a[key] !== b[key]).sort();
}

/** A session document only the split-brain probe writes. */
const SplitBrainMark = /* @__PURE__ */ defineDoc<{ at: number; by: string }>({
	kind: 'flue.qualification.split-brain',
	version: 1,
	scope: 'session',
	initial: () => ({ at: 0, by: '' }),
});

/**
 * Become a second writer of an entity's Pi log: open a fresh database over it
 * (the rebuild a new Durable Object does, which takes the next producer
 * epoch) and commit one session-document write, published before returning.
 * The live writer still holds the older epoch, so its next publish is fenced
 * (403) and it stops accepting commits — the split-brain guard. Destructive
 * for that entity: use a throwaway one.
 */
export async function splitBrainCommit(options: {
	readonly storage: DurableObjectSqliteStorage;
	readonly log: DurableStreamLog;
	readonly entity: EntityAddress;
	readonly context?: Context;
}): Promise<Record<string, unknown>> {
	const context = options.context ?? qualificationContext;
	const fences: string[] = [];
	const storage = await StreamStorage.open(
		{
			database: doSqliteDatabase(options.storage),
			log: options.log,
			entity: options.entity,
			relay: false,
			publish: 'await',
			onFenced: (epoch, reason) => fences.push(`${reason}@${epoch}`),
		},
		context,
	);
	try {
		const harness = await Harness.open(
			storage,
			{ models: createModels(), registry: createRegistry() },
			context,
		);
		let seq: number;
		try {
			const before = indexedSeq(options.storage.sql);
			await harness.commit(async (tx) => {
				const mark = await tx.doc(SplitBrainMark);
				mark.at = Date.now();
				mark.by = 'qualification split-brain probe';
			}, context);
			seq = indexedSeq(options.storage.sql);
			if (seq !== before + 1) throw new Error(`expected one commit, the index moved ${before} → ${seq}`);
		} finally {
			await harness.close(context);
		}
		const drained = await storage.drain();
		const producer = storage.outbox.requireProducer();
		return {
			seq,
			epoch: producer.epoch,
			publishedSeq: producer.publishedSeq,
			pending: storage.outbox.pending(),
			drain: drained.status,
			fences,
		};
	} finally {
		await storage.close(context);
	}
}
