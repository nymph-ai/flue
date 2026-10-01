/**
 * `conversationStreamStoreLog(store)` — a {@link DurableStreamLog} over any
 * {@link ConversationStreamStore}, so the SQL store and the external adapters
 * (postgres, mysql, libsql, mongodb, redis) can carry the canonical log
 * unchanged (PI_UPGRADE_PLAN.md §2.2).
 *
 * Each append is ONE store batch holding ONE record, the append envelope
 * `{ type: "durable_stream_append", producer, streamSeq?, messages }`. The
 * store's all-or-nothing batch contract gives the append its atomicity, and
 * the store's batch offsets are the log's offsets.
 *
 * The Durable Streams fences (client-declared producer epochs, `Stream-Seq`)
 * are enforced here, from producer state the bridge folds out of the envelopes
 * already in the stream — the stream itself is the source of truth, so a
 * fresh bridge over an existing stream enforces exactly what the old one did.
 * Races between bridges over one store are closed by the store's own
 * single-writer fence: the bridge holds the store producer for the path, and
 * a write under a claim another bridge has since taken over fails, after
 * which the bridge re-acquires, re-folds the stream, and re-validates.
 * Concurrent bridges on one path therefore stay correct but take turns; the
 * intended shape is one writer per path.
 */

import type { ConversationRecord } from '../legacy/conversation-records.ts';
import { ConversationStreamStoreError } from '../errors.ts';
import type {
	ConversationProducerClaim,
	ConversationStreamIdentity,
	ConversationStreamStore,
} from '../runtime/conversation-stream-store.ts';
import {
	type AppendOutcome,
	type DurableStreamLog,
	DurableStreamLogError,
	type ProducerClaim,
	type ReadBatch,
} from './log.ts';
import { asStreamOffset, STREAM_NOW, STREAM_START, type StreamOffset } from './offset.ts';
import {
	assertProducerClaim,
	type ProducerState,
	serializeMessages,
	streamSeqAdvances,
	validateProducer,
} from './producer-fence.ts';

export interface ConversationStreamStoreLogOptions {
	/**
	 * The store identity a path's stream is created with. Stores reject a
	 * second create with a different identity, so it must be a pure function
	 * of the path. Default: `{ agentName: "durable-stream-log", instanceId: path }`.
	 */
	readonly identity?: (path: string) => ConversationStreamIdentity;
	/** The store producer id the bridge writes under (default `"durable-stream-log"`). */
	readonly writerId?: string;
	/** How long a live read waits for data (default 30s). */
	readonly longPollTimeoutMs?: number;
	/** Durable poll interval under a live read, for stores whose `subscribe` is advisory (default 250ms). */
	readonly pollIntervalMs?: number;
}

/** The single record one append is stored as. */
interface AppendEnvelope {
	readonly v: 1;
	readonly id: string;
	readonly type: 'durable_stream_append';
	readonly producer: ProducerClaim;
	readonly streamSeq?: string;
	readonly messages: readonly unknown[];
}

interface PathState {
	incarnation: string | undefined;
	/** Last store batch folded into the fence state. */
	foldedThrough: string;
	producers: Map<string, ProducerState>;
	lastStreamSeq: string | undefined;
	claim: ConversationProducerClaim | undefined;
	chain: Promise<unknown>;
}

const APPEND_ATTEMPTS = 8;
const FOLD_PAGE = 1000;

function isAppendEnvelope(value: unknown): value is AppendEnvelope {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Partial<AppendEnvelope>;
	return (
		record.type === 'durable_stream_append' &&
		Array.isArray(record.messages) &&
		typeof record.producer === 'object' &&
		record.producer !== null
	);
}

export function conversationStreamStoreLog(
	store: ConversationStreamStore,
	options: ConversationStreamStoreLogOptions = {},
): DurableStreamLog {
	return new ConversationStreamStoreLog(store, options);
}

class ConversationStreamStoreLog implements DurableStreamLog {
	private readonly paths = new Map<string, PathState>();
	private readonly identity: (path: string) => ConversationStreamIdentity;
	private readonly writerId: string;
	private readonly longPollTimeoutMs: number;
	private readonly pollIntervalMs: number;

	constructor(
		private readonly store: ConversationStreamStore,
		options: ConversationStreamStoreLogOptions,
	) {
		this.identity =
			options.identity ?? ((path) => ({ agentName: 'durable-stream-log', instanceId: path }));
		this.writerId = options.writerId ?? 'durable-stream-log';
		this.longPollTimeoutMs = options.longPollTimeoutMs ?? 30_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 250;
	}

	async ensure(path: string): Promise<{ readonly nextOffset: StreamOffset }> {
		try {
			await this.store.createStream(path, this.identity(path));
		} catch (error) {
			throw this.translate(path, error, 'conflict');
		}
		const meta = await this.store.getMeta(path);
		if (!meta) throw this.notFound(path);
		return { nextOffset: asStreamOffset(meta.nextOffset) };
	}

	async append(
		path: string,
		input: {
			readonly messages: readonly unknown[];
			readonly producer: ProducerClaim;
			readonly streamSeq?: string;
		},
	): Promise<AppendOutcome> {
		assertProducerClaim(path, input.producer);
		// Validate the payload before queueing so a bad request never waits.
		serializeMessages(path, input.messages);
		const state = this.state(path);
		const result = state.chain.then(() => this.appendSerialized(path, state, input));
		state.chain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async read(
		path: string,
		from: StreamOffset,
		options: {
			readonly live?: false | 'long-poll' | 'sse';
			readonly cursor?: string;
			readonly signal?: AbortSignal;
		} = {},
	): Promise<ReadBatch> {
		const meta = await this.store.getMeta(path);
		if (!meta) throw this.notFound(path);
		const live = options.live === 'long-poll' || options.live === 'sse';
		const start = from === STREAM_NOW ? asStreamOffset(meta.nextOffset) : from;
		let batch = await this.readOnce(path, start);
		if (live && batch.messages.length === 0 && batch.upToDate) {
			await this.waitForData(path, start, options.signal);
			batch = await this.readOnce(path, start);
		}
		return live ? { ...batch, cursor: nextCursor(options.cursor) } : batch;
	}

	async head(
		path: string,
	): Promise<{ readonly nextOffset: StreamOffset; readonly closed: boolean } | null> {
		const meta = await this.store.getMeta(path);
		return meta ? { nextOffset: asStreamOffset(meta.nextOffset), closed: false } : null;
	}

	subscribe(path: string, listener: () => void): () => void {
		return this.store.subscribe(path, listener);
	}

	private state(path: string): PathState {
		let state = this.paths.get(path);
		if (!state) {
			state = {
				incarnation: undefined,
				foldedThrough: STREAM_START,
				producers: new Map(),
				lastStreamSeq: undefined,
				claim: undefined,
				chain: Promise.resolve(),
			};
			this.paths.set(path, state);
		}
		return state;
	}

	private async appendSerialized(
		path: string,
		state: PathState,
		input: {
			readonly messages: readonly unknown[];
			readonly producer: ProducerClaim;
			readonly streamSeq?: string;
		},
	): Promise<AppendOutcome> {
		let lastError: unknown;
		for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
			try {
				const meta = await this.store.getMeta(path);
				if (!meta) throw this.notFound(path);
				if (state.incarnation !== meta.incarnation) {
					// A wiped and regrown stream: its writer state starts over.
					state.incarnation = meta.incarnation;
					state.foldedThrough = STREAM_START;
					state.producers = new Map();
					state.lastStreamSeq = undefined;
					state.claim = undefined;
				}
				const owned =
					state.claim !== undefined &&
					meta.producerId === state.claim.producerId &&
					meta.producerEpoch === state.claim.producerEpoch;
				if (!owned) state.claim = await this.store.acquireProducer(path, this.writerId);
				const claim = state.claim as ConversationProducerClaim;
				// Fold after acquiring: every batch another writer landed before
				// the acquire is visible now, and none can land after it without
				// failing the append below.
				await this.fold(path, state);

				const producerState = state.producers.get(input.producer.id);
				const decision = validateProducer(path, producerState, input.producer);
				if (decision.kind === 'duplicate') {
					return { status: 'duplicate', nextOffset: asStreamOffset(state.foldedThrough) };
				}
				if (decision.kind === 'fenced') {
					return { status: 'fenced', currentEpoch: decision.currentEpoch };
				}
				if (decision.kind === 'gap') {
					return { status: 'producer-gap', expectedSeq: decision.expectedSeq };
				}
				if (!streamSeqAdvances(state.lastStreamSeq, input.streamSeq)) {
					return {
						status: 'stream-seq-conflict',
						nextOffset: asStreamOffset(state.foldedThrough),
					};
				}
				const envelope: AppendEnvelope = {
					v: 1,
					id: `${input.producer.id}:${input.producer.epoch}:${input.producer.seq}`,
					type: 'durable_stream_append',
					producer: {
						id: input.producer.id,
						epoch: input.producer.epoch,
						seq: input.producer.seq,
					},
					...(input.streamSeq === undefined ? {} : { streamSeq: input.streamSeq }),
					messages: input.messages,
				};
				// The store's next sequence comes from its meta, not a local
				// counter: an append that committed but whose reply was lost
				// has already advanced it (and the fold above has already
				// turned the retry into a duplicate).
				const producerSequence = owned ? meta.nextProducerSequence : claim.nextProducerSequence;
				const { offset } = await this.store.append({
					path,
					producerId: claim.producerId,
					producerEpoch: claim.producerEpoch,
					incarnation: claim.incarnation,
					producerSequence,
					records: [envelope as unknown as ConversationRecord],
				});
				return { status: 'appended', nextOffset: asStreamOffset(offset) };
			} catch (error) {
				if (error instanceof DurableStreamLogError) throw error;
				if (error instanceof ConversationStreamStoreError) {
					// Another writer took the store producer (or the stream
					// moved under us): re-acquire, re-fold, re-validate.
					state.claim = undefined;
					lastError = error;
					// Jittered backoff breaks acquire/append alternation between
					// two bridges contending for the same path.
					await new Promise((resolve) => setTimeout(resolve, Math.random() * 5 * (attempt + 1)));
					continue;
				}
				return { status: 'retryable', error };
			}
		}
		return { status: 'retryable', error: lastError };
	}

	/** Fold every envelope after `foldedThrough` into the fence state. */
	private async fold(path: string, state: PathState): Promise<void> {
		while (true) {
			const read = await this.store.read(path, { offset: state.foldedThrough, limit: FOLD_PAGE });
			for (const batch of read.batches) {
				for (const stored of batch.records) {
					const record: unknown = stored;
					if (!isAppendEnvelope(record)) {
						throw new DurableStreamLogError({
							code: 'protocol',
							path,
							message: `Batch ${batch.offset} holds a record that is not a durable stream append.`,
						});
					}
					state.producers.set(record.producer.id, {
						epoch: record.producer.epoch,
						lastSeq: record.producer.seq,
					});
					if (record.streamSeq !== undefined) state.lastStreamSeq = record.streamSeq;
				}
				state.foldedThrough = batch.offset;
			}
			if (read.upToDate) return;
		}
	}

	private async readOnce(path: string, from: StreamOffset): Promise<ReadBatch> {
		let read: Awaited<ReturnType<ConversationStreamStore['read']>>;
		try {
			read = await this.store.read(path, { offset: from });
		} catch (error) {
			throw this.translate(path, error, 'bad-request');
		}
		const messages: unknown[] = [];
		for (const batch of read.batches) {
			for (const stored of batch.records) {
				const record: unknown = stored;
				if (!isAppendEnvelope(record)) {
					throw new DurableStreamLogError({
						code: 'protocol',
						path,
						message: `Batch ${batch.offset} holds a record that is not a durable stream append.`,
					});
				}
				messages.push(...record.messages);
			}
		}
		return {
			messages,
			nextOffset: asStreamOffset(read.nextOffset),
			upToDate: read.upToDate,
			closed: false,
		};
	}

	/** Wait for a batch after `from`, bounded by the long-poll window; rejects on abort. */
	private async waitForData(path: string, from: StreamOffset, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + this.longPollTimeoutMs;
		let wake: (() => void) | undefined;
		let pending = false;
		const unsubscribe = this.store.subscribe(path, () => {
			pending = true;
			wake?.();
		});
		const onAbort = () => wake?.();
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			while (true) {
				if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
				pending = false;
				const probe = await this.store.read(path, { offset: from, limit: 1 });
				if (probe.batches.length > 0 || Date.now() >= deadline) return;
				if (pending) continue;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(
						finish,
						Math.max(0, Math.min(this.pollIntervalMs, deadline - Date.now())),
					);
					function finish() {
						clearTimeout(timer);
						resolve();
					}
					wake = finish;
					if (pending || signal?.aborted) finish();
				});
				wake = undefined;
			}
		} finally {
			unsubscribe();
			signal?.removeEventListener('abort', onAbort);
		}
	}

	private notFound(path: string): DurableStreamLogError {
		return new DurableStreamLogError({
			code: 'not-found',
			path,
			message: 'Stream not found.',
			status: 404,
		});
	}

	private translate(
		path: string,
		error: unknown,
		code: 'conflict' | 'bad-request',
	): DurableStreamLogError {
		if (error instanceof DurableStreamLogError) return error;
		if (error instanceof ConversationStreamStoreError) {
			return new DurableStreamLogError({ code, path, message: error.dev, cause: error });
		}
		return new DurableStreamLogError({
			code: 'unavailable',
			path,
			message: error instanceof Error ? error.message : String(error),
			cause: error,
		});
	}
}

/** A monotonically advancing `Stream-Cursor`, echoing past the client's (PROTOCOL §10.1). */
function nextCursor(client: string | undefined): string {
	const interval = Math.floor(Date.now() / 20_000);
	const echoed = client === undefined ? Number.NaN : Number(client);
	return String(Number.isSafeInteger(echoed) && echoed >= interval ? echoed + 1 : interval);
}
