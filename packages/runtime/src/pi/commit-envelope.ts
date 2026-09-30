/**
 * The canonical Pi log record (PI_UPGRADE_PLAN.md §2.3): one atomic Pi Durable
 * commit is one {@link PiCommitEnvelope}, published as one Durable Streams
 * POST. An envelope larger than `maxMessageBytes` travels as a run of
 * {@link PiCommitPart}s, still in one POST, so it stays atomic.
 *
 * Encoding is plain JSON of the exact `StorageWrite[]` Pi committed, including
 * `document.change` delta ops. It is lossless for every value Pi Durable can
 * commit: Pi's Session only admits strict JSON, and `SqliteStorage` itself
 * persists records with `JSON.stringify`, so a replayed envelope rebuilds the
 * exact index the original commit produced. {@link encodeCommitEnvelope}
 * rejects the values JSON would silently change (non-finite numbers, holes,
 * non-plain objects) rather than publish something replay could not honour.
 * An object property whose value is `undefined` is dropped, exactly as the
 * SQLite index drops it.
 */

import type { StorageWrite } from '@earendil-works/pi-durable';

export const PI_COMMIT_TYPE = 'pi.commit';
export const PI_COMMIT_PART_TYPE = 'pi.commit.part';

/** One atomic Pi commit = one Durable Streams POST. */
export interface PiCommitEnvelope {
	readonly v: 1;
	readonly type: typeof PI_COMMIT_TYPE;
	/** Storage incarnation (ULID): every envelope of one log carries the same value. */
	readonly storage: string;
	/** The Pi `Seq` the index commit returned; contiguous from 1. */
	readonly seq: number;
	/**
	 * The producer epoch this envelope is published under. A fresh index that
	 * rebuilds from the log starts one epoch above the highest it replays, so it
	 * can never be mistaken for an in-epoch retry of an earlier writer.
	 */
	readonly epoch: number;
	/** Commit time, ms since the epoch. */
	readonly at: number;
	/** Exact, replayable. */
	readonly writes: readonly StorageWrite[];
}

/** Present only when an envelope exceeds `maxMessageBytes`; all parts go in ONE POST. */
export interface PiCommitPart {
	readonly v: 1;
	readonly type: typeof PI_COMMIT_PART_TYPE;
	readonly storage: string;
	readonly seq: number;
	readonly index: number;
	readonly count: number;
	/** A slice of the envelope's JSON text; the parts concatenate to it. */
	readonly chunk: string;
}

export type PiLogMessage = PiCommitEnvelope | PiCommitPart;

/** Thrown for anything on the log that is not a well-formed Pi commit record. */
export class PiCommitEnvelopeError extends Error {
	constructor(message: string) {
		super(`[flue] ${message}`);
		this.name = 'PiCommitEnvelopeError';
	}
}

const TABLE_WRITES = new Set(['conversation', 'entry', 'task', 'submission']);
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeqNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Throw unless JSON round-trips `value` without changing it (modulo dropped `undefined` properties). */
function assertExactJson(value: unknown, path: string): void {
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return;
		case 'number':
			if (!Number.isFinite(value)) {
				throw new PiCommitEnvelopeError(`Commit value at ${path} is ${value}, which JSON cannot carry.`);
			}
			return;
		case 'object': {
			if (value === null) return;
			if (Array.isArray(value)) {
				for (let index = 0; index < value.length; index++) {
					if (!(index in value) || value[index] === undefined) {
						throw new PiCommitEnvelopeError(`Commit array at ${path} has a hole at ${index}.`);
					}
					assertExactJson(value[index], `${path}[${index}]`);
				}
				return;
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new PiCommitEnvelopeError(`Commit value at ${path} is not a plain object.`);
			}
			if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
				throw new PiCommitEnvelopeError(`Commit value at ${path} defines toJSON.`);
			}
			for (const [key, item] of Object.entries(value)) {
				if (item === undefined) continue;
				assertExactJson(item, `${path}.${key}`);
			}
			return;
		}
		default:
			throw new PiCommitEnvelopeError(`Commit value at ${path} is a ${typeof value}, which JSON cannot carry.`);
	}
}

function assertWrite(write: unknown, index: number): asserts write is StorageWrite {
	const where = `writes[${index}]`;
	if (!isRecord(write) || typeof write.type !== 'string') {
		throw new PiCommitEnvelopeError(`${where} is not a storage write.`);
	}
	const { type } = write;
	if (TABLE_WRITES.has(type)) {
		if (!isRecord(write.value) || !isSeqNumber(write.value.id)) {
			throw new PiCommitEnvelopeError(`${where} (${type}) has no record with a numeric id.`);
		}
		return;
	}
	switch (type) {
		case 'document.create': {
			const content = write.content;
			if (
				!isRecord(write.record) ||
				!isSeqNumber(write.record.id) ||
				!isRecord(content) ||
				content.kind !== 'base' ||
				!isRecord(content.value)
			) {
				throw new PiCommitEnvelopeError(`${where} (document.create) is malformed.`);
			}
			return;
		}
		case 'document.copy': {
			const source = write.source;
			if (
				!isRecord(write.record) ||
				!isSeqNumber(write.record.id) ||
				!isRecord(source) ||
				!isSeqNumber(source.id) ||
				!(source.at === 'current' || isSeqNumber(source.at))
			) {
				throw new PiCommitEnvelopeError(`${where} (document.copy) is malformed.`);
			}
			return;
		}
		case 'document.change': {
			const content = write.content;
			const valid =
				isSeqNumber(write.id) &&
				isRecord(content) &&
				isNonNegativeInteger(content.version) &&
				((content.kind === 'base' && isRecord(content.value)) ||
					(content.kind === 'delta' && Array.isArray(content.ops)));
			if (!valid) throw new PiCommitEnvelopeError(`${where} (document.change) is malformed.`);
			return;
		}
		case 'document.retire':
			if (!isSeqNumber(write.id)) {
				throw new PiCommitEnvelopeError(`${where} (document.retire) is malformed.`);
			}
			return;
		default:
			throw new PiCommitEnvelopeError(`${where} has unknown storage write type "${type}".`);
	}
}

function assertEnvelope(value: unknown): asserts value is PiCommitEnvelope {
	if (
		!isRecord(value) ||
		value.v !== 1 ||
		value.type !== PI_COMMIT_TYPE ||
		typeof value.storage !== 'string' ||
		value.storage.length === 0 ||
		!isSeqNumber(value.seq) ||
		!isNonNegativeInteger(value.epoch) ||
		typeof value.at !== 'number' ||
		!Number.isFinite(value.at) ||
		!Array.isArray(value.writes)
	) {
		throw new PiCommitEnvelopeError('Log message is not a Pi commit envelope.');
	}
	for (let index = 0; index < value.writes.length; index++) assertWrite(value.writes[index], index);
}

function assertPart(value: unknown): asserts value is PiCommitPart {
	if (
		!isRecord(value) ||
		value.v !== 1 ||
		value.type !== PI_COMMIT_PART_TYPE ||
		typeof value.storage !== 'string' ||
		!isSeqNumber(value.seq) ||
		!isNonNegativeInteger(value.index) ||
		!isSeqNumber(value.count) ||
		value.index >= value.count ||
		typeof value.chunk !== 'string'
	) {
		throw new PiCommitEnvelopeError('Log message is not a Pi commit part.');
	}
}

/** Build and validate an envelope; throws {@link PiCommitEnvelopeError} for writes JSON cannot carry exactly. */
export function createCommitEnvelope(input: Omit<PiCommitEnvelope, 'v' | 'type'>): PiCommitEnvelope {
	const envelope: PiCommitEnvelope = {
		v: 1,
		type: PI_COMMIT_TYPE,
		storage: input.storage,
		seq: input.seq,
		epoch: input.epoch,
		at: input.at,
		writes: input.writes,
	};
	assertEnvelope(envelope);
	assertExactJson(envelope.writes, 'writes');
	return envelope;
}

/** The envelope's JSON text: what the outbox stores and what the log carries. */
export function encodeCommitEnvelope(envelope: PiCommitEnvelope): string {
	return JSON.stringify(createCommitEnvelope(envelope));
}

/** Decode an envelope from its JSON text or its parsed form. */
export function decodeCommitEnvelope(input: string | unknown): PiCommitEnvelope {
	let value: unknown = input;
	if (typeof input === 'string') {
		try {
			value = JSON.parse(input);
		} catch {
			throw new PiCommitEnvelopeError('Pi commit envelope is not JSON.');
		}
	}
	assertEnvelope(value);
	return value;
}

/** Validate one message read off the Pi log. */
export function decodeLogMessage(message: unknown): PiLogMessage {
	if (isRecord(message) && message.type === PI_COMMIT_PART_TYPE) {
		assertPart(message);
		return message;
	}
	return decodeCommitEnvelope(message);
}

/** UTF-8 bytes `text` occupies inside a JSON string literal (without the quotes). */
function jsonStringBytes(codePoint: number): number {
	if (codePoint === 0x22 || codePoint === 0x5c) return 2; // \" \\
	if (codePoint < 0x20) return 6; // \u00XX (upper bound; \n and friends are 2)
	if (codePoint < 0x80) return 1;
	if (codePoint < 0x800) return 2;
	if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6; // lone surrogate, escaped
	if (codePoint < 0x10000) return 3;
	return 4;
}

/** Room left for `chunk` in one part message after its other fields. */
const PART_OVERHEAD_BYTES = 512;

/**
 * The messages one outbox row is published as: the envelope itself, or — when
 * its JSON exceeds `maxMessageBytes` — parts whose chunks concatenate to that
 * JSON text. Either way the caller sends them in one POST.
 */
export function commitMessages(body: string, maxMessageBytes: number): unknown[] {
	if (encoder.encode(body).length <= maxMessageBytes) return [JSON.parse(body)];
	const envelope = decodeCommitEnvelope(body);
	const budget = Math.max(maxMessageBytes - PART_OVERHEAD_BYTES, 16);
	const chunks: string[] = [];
	let start = 0;
	let used = 0;
	let index = 0;
	while (index < body.length) {
		const codePoint = body.codePointAt(index) as number;
		const width = codePoint > 0xffff ? 2 : 1;
		const bytes = jsonStringBytes(codePoint);
		if (used + bytes > budget && index > start) {
			chunks.push(body.slice(start, index));
			start = index;
			used = 0;
		}
		used += bytes;
		index += width;
	}
	chunks.push(body.slice(start));
	return chunks.map(
		(chunk, part): PiCommitPart => ({
			v: 1,
			type: PI_COMMIT_PART_TYPE,
			storage: envelope.storage,
			seq: envelope.seq,
			index: part,
			count: chunks.length,
			chunk,
		}),
	);
}

/**
 * Reassembles envelopes from log messages in stream order. Parts of one
 * envelope are contiguous (they were one POST); anything else throws.
 */
export class CommitAssembler {
	private parts: PiCommitPart[] = [];

	/** The envelope this message completes, or `undefined` while parts are pending. */
	accept(message: unknown): PiCommitEnvelope | undefined {
		const decoded = decodeLogMessage(message);
		if (decoded.type === PI_COMMIT_TYPE) {
			if (this.parts.length > 0) {
				throw new PiCommitEnvelopeError(
					`Pi commit ${this.parts[0]?.seq} is missing parts: an envelope interrupted it.`,
				);
			}
			return decoded;
		}
		const first = this.parts[0];
		if (
			decoded.index !== this.parts.length ||
			(first !== undefined &&
				(first.seq !== decoded.seq ||
					first.count !== decoded.count ||
					first.storage !== decoded.storage))
		) {
			throw new PiCommitEnvelopeError(
				`Pi commit part ${decoded.seq}#${decoded.index} is out of order.`,
			);
		}
		this.parts.push(decoded);
		if (this.parts.length < decoded.count) return undefined;
		const text = this.parts.map((part) => part.chunk).join('');
		this.parts = [];
		const envelope = decodeCommitEnvelope(text);
		if (envelope.seq !== decoded.seq || envelope.storage !== decoded.storage) {
			throw new PiCommitEnvelopeError(`Pi commit parts of ${decoded.seq} assemble a different commit.`);
		}
		return envelope;
	}

	/** Whether an envelope is partially assembled (a read ended mid-POST, which the log never does). */
	get pending(): boolean {
		return this.parts.length > 0;
	}
}

/** `Stream-Seq` for a Pi seq: zero-padded so lexicographic order is numeric order. */
export function streamSeqFor(seq: number): string {
	return String(seq).padStart(16, '0');
}

/**
 * Whether two envelopes are the same semantic commit. The epoch is a
 * publication detail (it is rewritten when pending rows move to a new epoch),
 * so it is not compared.
 */
export function sameCommit(a: PiCommitEnvelope, b: PiCommitEnvelope): boolean {
	return (
		a.storage === b.storage &&
		a.seq === b.seq &&
		a.at === b.at &&
		JSON.stringify(a.writes) === JSON.stringify(b.writes)
	);
}
