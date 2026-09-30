/**
 * `InMemoryDurableStreamLog` — the protocol-exact test double for
 * {@link DurableStreamLog}. It reproduces what the Durable Streams Node
 * reference server (`@durable-streams/server`, the server Electric's
 * agents-server embeds) does for `application/json` streams:
 *
 * - offsets are `<segment>_<bytes>`, two 16-digit zero-padded integers, the
 *   empty stream's tail is `0000000000000000_0000000000000000`, and each
 *   append advances the byte counter by its size plus a 5-byte frame;
 * - one append is one stored unit holding every message of the POST;
 * - producer and `Stream-Seq` fences per `producer-fence.ts`;
 * - a read after the tail returns nothing, up to date, at the tail;
 * - a long-poll waits only when the reader is exactly at the tail (or used
 *   `now`) and returns an empty, up-to-date batch at the tail on timeout.
 *
 * `live: "sse"` is served like a long-poll (one batch per call): the double
 * has no connection to keep open.
 */

import { StreamListenerRegistry } from '../runtime/conversation-stream-store.ts';
import {
	type AppendOutcome,
	type DurableStreamLog,
	DurableStreamLogError,
	type ProducerClaim,
	type ReadBatch,
} from './log.ts';
import {
	asStreamOffset,
	compareOffsets,
	STREAM_NOW,
	STREAM_START,
	type StreamOffset,
} from './offset.ts';
import {
	assertProducerClaim,
	type ProducerState,
	serializeMessages,
	streamSeqAdvances,
	validateProducer,
} from './producer-fence.ts';

export interface InMemoryDurableStreamLogOptions {
	/** How long a live read waits for data before returning empty (default 30s, like the reference server). */
	readonly longPollTimeoutMs?: number;
	/**
	 * Cap on messages returned per read, never splitting an append. Unset
	 * returns everything after the offset, as the reference server does.
	 */
	readonly maxReadMessages?: number;
}

interface StoredAppend {
	readonly offset: StreamOffset;
	readonly data: string;
	readonly count: number;
}

interface MemoryStream {
	readonly appends: StoredAppend[];
	tail: StreamOffset;
	bytes: number;
	readonly producers: Map<string, ProducerState>;
	lastStreamSeq?: string;
	closed: boolean;
}

const OFFSET_COMPONENT = 16;
const FRAME_OVERHEAD = 5;
const encoder = new TextEncoder();

function mintOffset(bytes: number): StreamOffset {
	return asStreamOffset(
		`${'0'.repeat(OFFSET_COMPONENT)}_${String(bytes).padStart(OFFSET_COMPONENT, '0')}`,
	);
}

export class InMemoryDurableStreamLog implements DurableStreamLog {
	private readonly streams = new Map<string, MemoryStream>();
	private readonly listeners = new StreamListenerRegistry();
	private readonly longPollTimeoutMs: number;
	private readonly maxReadMessages: number | undefined;

	constructor(options: InMemoryDurableStreamLogOptions = {}) {
		this.longPollTimeoutMs = options.longPollTimeoutMs ?? 30_000;
		this.maxReadMessages = options.maxReadMessages;
	}

	async ensure(path: string): Promise<{ readonly nextOffset: StreamOffset }> {
		let stream = this.streams.get(path);
		if (!stream) {
			stream = {
				appends: [],
				tail: mintOffset(0),
				bytes: 0,
				producers: new Map(),
				closed: false,
			};
			this.streams.set(path, stream);
		}
		return { nextOffset: stream.tail };
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
		const stream = this.require(path);
		// The reference server checks closure first, then content, then
		// producer, then Stream-Seq; the double never closes streams.
		const data = serializeMessages(path, input.messages);
		const producerState = stream.producers.get(input.producer.id);
		const decision = validateProducer(path, producerState, input.producer);
		switch (decision.kind) {
			case 'duplicate':
				return { status: 'duplicate', nextOffset: stream.tail };
			case 'fenced':
				return { status: 'fenced', currentEpoch: decision.currentEpoch };
			case 'gap':
				return { status: 'producer-gap', expectedSeq: decision.expectedSeq };
		}
		if (!streamSeqAdvances(stream.lastStreamSeq, input.streamSeq)) {
			// Nothing is committed: neither the producer seq nor the stream seq.
			return { status: 'stream-seq-conflict', nextOffset: stream.tail };
		}
		stream.bytes += FRAME_OVERHEAD + encoder.encode(data).length;
		const offset = mintOffset(stream.bytes);
		stream.appends.push({ offset, data, count: input.messages.length });
		stream.tail = offset;
		stream.producers.set(input.producer.id, decision.next);
		if (input.streamSeq !== undefined) stream.lastStreamSeq = input.streamSeq;
		this.listeners.notify(path);
		return { status: 'appended', nextOffset: offset };
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
		const stream = this.require(path);
		const live = options.live === 'long-poll' || options.live === 'sse';
		if (from === STREAM_NOW && !live) {
			return { messages: [], nextOffset: stream.tail, upToDate: true, closed: stream.closed };
		}
		const start = from === STREAM_NOW ? stream.tail : from;
		let batch = this.readFrom(stream, start);
		if (live) {
			batch = { ...batch, cursor: this.nextCursor(options.cursor) };
			const caughtUp = from === STREAM_NOW || start === stream.tail;
			if (batch.messages.length === 0 && caughtUp && !stream.closed) {
				// On timeout this is an empty, up-to-date batch at the tail — the
				// reference server's 204.
				await this.waitForAppend(path, options.signal);
				batch = { ...this.readFrom(stream, start), cursor: this.nextCursor(options.cursor) };
			}
		}
		return batch;
	}

	async head(
		path: string,
	): Promise<{ readonly nextOffset: StreamOffset; readonly closed: boolean } | null> {
		const stream = this.streams.get(path);
		return stream ? { nextOffset: stream.tail, closed: stream.closed } : null;
	}

	subscribe(path: string, listener: () => void): () => void {
		return this.listeners.subscribe(path, listener);
	}

	private require(path: string): MemoryStream {
		const stream = this.streams.get(path);
		if (!stream) {
			throw new DurableStreamLogError({
				code: 'not-found',
				path,
				message: 'Stream not found.',
				status: 404,
			});
		}
		return stream;
	}

	private readFrom(stream: MemoryStream, from: StreamOffset): ReadBatch {
		const index =
			from === STREAM_START
				? 0
				: stream.appends.findIndex((entry) => compareOffsets(entry.offset, from) > 0);
		const pending = index === -1 ? [] : stream.appends.slice(index);
		const page: StoredAppend[] = [];
		let count = 0;
		for (const entry of pending) {
			const full = this.maxReadMessages !== undefined && count + entry.count > this.maxReadMessages;
			if (full && page.length > 0) break;
			page.push(entry);
			count += entry.count;
		}
		const upToDate = page.length === pending.length;
		return {
			messages: page.flatMap((entry) => JSON.parse(entry.data) as unknown[]),
			nextOffset: page.at(-1)?.offset ?? stream.tail,
			upToDate,
			closed: stream.closed && upToDate,
		};
	}

	/** Resolves `true` on an append to `path`, `false` on timeout; rejects on abort. */
	private waitForAppend(path: string, signal: AbortSignal | undefined): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
				return;
			}
			const finish = (outcome: () => void) => {
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener('abort', onAbort);
				outcome();
			};
			const onAbort = () =>
				finish(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')));
			const unsubscribe = this.listeners.subscribe(path, () => finish(() => resolve(true)));
			const timer = setTimeout(() => finish(() => resolve(false)), this.longPollTimeoutMs);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}

	/** A monotonically advancing `Stream-Cursor`, echoing past the client's (PROTOCOL §10.1). */
	private nextCursor(client: string | undefined): string {
		const interval = Math.floor(Date.now() / 20_000);
		const echoed = client === undefined ? Number.NaN : Number(client);
		return String(Number.isSafeInteger(echoed) && echoed >= interval ? echoed + 1 : interval);
	}
}
