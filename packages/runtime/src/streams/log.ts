/**
 * The canonical log port (PI_UPGRADE_PLAN.md §2.2): one Durable Streams
 * `application/json` stream per path, written through an idempotent producer.
 *
 * Implementations:
 * - `memory-log.ts` — `InMemoryDurableStreamLog`, the protocol-exact test double.
 * - `store-bridge-log.ts` — `conversationStreamStoreLog(store)`, over any
 *   `ConversationStreamStore` (SQL, Redis, MongoDB, ...).
 * - `electric-log.ts` — `ElectricDurableStreamLog`, the Durable Streams HTTP
 *   protocol (fetch only, so it runs on workerd).
 *
 * Semantics every implementation follows (PROTOCOL.md §5.2, §5.2.1, §8, §9.1),
 * pinned by `test-utils/define-durable-stream-log-contract-tests.ts`:
 *
 * - One `append` is atomic: all of `messages` land under one offset or none
 *   do, and a read never splits them.
 * - Producer fencing, per `(path, producer.id)`: an epoch below the stream's
 *   is `fenced` (with the current epoch); a higher epoch must start at seq 0
 *   (anything else is a {@link DurableStreamLogError} `bad-request`); within an
 *   epoch, `seq <= lastSeq` is a `duplicate`, `lastSeq + 1` appends, and
 *   anything higher is a `producer-gap` naming the expected seq. A producer
 *   the stream has never seen must start at seq 0 (`producer-gap`,
 *   `expectedSeq: 0`, otherwise).
 * - `streamSeq` (`Stream-Seq`) is per stream and compared byte-wise
 *   lexicographically: a value at or below the last accepted one is a
 *   `stream-seq-conflict`. It is checked AFTER producer dedup, so an in-epoch
 *   retry is still a `duplicate`; and a `stream-seq-conflict` consumes nothing —
 *   neither the producer seq nor the stream seq advance (both reference servers
 *   commit producer state only after the Stream-Seq check passes).
 */

import type { StreamOffset } from './offset.ts';

export interface ProducerClaim {
	readonly id: string;
	readonly epoch: number;
	readonly seq: number;
}

export type AppendOutcome =
	| { readonly status: 'appended'; readonly nextOffset: StreamOffset }
	/** 204: an in-epoch retry of an append that already landed. */
	| { readonly status: 'duplicate'; readonly nextOffset?: StreamOffset }
	/** 409 "Sequence conflict": `streamSeq` at or below the stream's last; typically already appended under an earlier epoch. */
	| { readonly status: 'stream-seq-conflict'; readonly nextOffset?: StreamOffset }
	/** 403: another writer holds a higher epoch. */
	| { readonly status: 'fenced'; readonly currentEpoch: number }
	/** 409 + `Producer-Expected-Seq`. */
	| { readonly status: 'producer-gap'; readonly expectedSeq: number }
	/** Network failure, 5xx, 429: nothing is known to have been appended; retry the same claim. */
	| { readonly status: 'retryable'; readonly error: unknown };

export interface ReadBatch {
	/** JSON messages (application/json streams), in stream order. */
	readonly messages: readonly unknown[];
	/** `Stream-Next-Offset`: resume the next read here. */
	readonly nextOffset: StreamOffset;
	readonly upToDate: boolean;
	readonly closed: boolean;
	/** `Stream-Cursor` (live reads); echo it on the next live read. */
	readonly cursor?: string;
}

export interface DurableStreamLog {
	/** PUT: create the stream if absent (idempotent). */
	ensure(path: string, signal?: AbortSignal): Promise<{ readonly nextOffset: StreamOffset }>;
	append(
		path: string,
		input: {
			/** One append ⇒ atomic; each element becomes one message. Must be non-empty. */
			readonly messages: readonly unknown[];
			readonly producer: ProducerClaim;
			/** `Stream-Seq`, e.g. a zero-padded Pi seq. */
			readonly streamSeq?: string;
		},
		signal?: AbortSignal,
	): Promise<AppendOutcome>;
	/** Messages strictly after `from`. `STREAM_START` reads from the beginning; `STREAM_NOW` from the tail. */
	read(
		path: string,
		from: StreamOffset,
		options?: {
			readonly live?: false | 'long-poll' | 'sse';
			readonly cursor?: string;
			readonly signal?: AbortSignal;
		},
	): Promise<ReadBatch>;
	/** HEAD: `null` when the stream does not exist. */
	head(
		path: string,
		signal?: AbortSignal,
	): Promise<{ readonly nextOffset: StreamOffset; readonly closed: boolean } | null>;
	/** In-process wakeups (memory/SQL); remote logs wake through webhooks instead. */
	subscribe?(path: string, listener: () => void): () => void;
}

export type DurableStreamLogErrorCode =
	/** 404: the stream does not exist. */
	| 'not-found'
	/** 410: the stream is soft-deleted. */
	| 'gone'
	/** 409 with `Stream-Closed: true`: the stream no longer accepts appends. */
	| 'closed'
	/** 409 for any other reason: PUT config mismatch, content-type mismatch. */
	| 'conflict'
	/** 400: malformed request, e.g. a new epoch not starting at seq 0, an empty append. */
	| 'bad-request'
	/** 413: the append is larger than the server accepts; split it. */
	| 'payload-too-large'
	/** Network failure, 5xx or 429 on an operation without a retryable outcome. */
	| 'unavailable'
	/** The server answered outside the protocol (missing headers, unparseable body). */
	| 'protocol';

/** A non-outcome failure of a {@link DurableStreamLog} operation. */
export class DurableStreamLogError extends Error {
	readonly code: DurableStreamLogErrorCode;
	readonly path: string;
	readonly status?: number;

	constructor(options: {
		code: DurableStreamLogErrorCode;
		path: string;
		message: string;
		status?: number;
		cause?: unknown;
	}) {
		super(
			`[flue] Durable stream "${options.path}": ${options.message}`,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = 'DurableStreamLogError';
		this.code = options.code;
		this.path = options.path;
		if (options.status !== undefined) this.status = options.status;
	}

	/** Whether retrying the identical request may succeed. */
	get retryable(): boolean {
		return this.code === 'unavailable';
	}
}
