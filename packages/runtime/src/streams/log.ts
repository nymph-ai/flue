/**
 * The entity stream port (docs/cloudflare-native.md rule 2): one Durable
 * Streams `application/json` stream per path. Electric carries only entity
 * events — an entity's inbox (`flue/v1/{type}/{id}/inbox`), what it publishes
 * (`…/events`), and the world streams entities observe. Pi's commits never
 * reach it.
 *
 * Implementations:
 * - `electric-log.ts` — `ElectricDurableStreamLog`, the Durable Streams HTTP
 *   protocol (fetch only, so it runs on workerd);
 * - `memory-log.ts` — `InMemoryDurableStreamLog`, the protocol-exact test
 *   double;
 * - `store-bridge-log.ts` — `conversationStreamStoreLog(store)`, entity
 *   streams in a Node app's own persistence adapter.
 *
 * An append is a plain POST: one atomic unit of messages under one offset.
 * There are no producer epochs. Every message carries a deterministic id
 * (`{self}/{taskId}/{callId}` for a tool call's send or publish) and the
 * receiver deduplicates on it (rule 5), so a retried POST that already landed
 * only appends a duplicate the receiver ignores. Durable Streams'
 * idempotent-producer headers would dedupe that retry at the server, but only
 * against a producer sequence the sender keeps durably — the outbox and
 * epochs this design removed — so they are not used.
 *
 * Reads are plain catch-up reads: nothing holds a connection open (rule 8).
 */

import type { StreamOffset } from './offset.ts';

export interface ReadBatch {
	/** JSON messages (application/json streams), in stream order. */
	readonly messages: readonly unknown[];
	/** `Stream-Next-Offset`: resume the next read here. */
	readonly nextOffset: StreamOffset;
	readonly upToDate: boolean;
	readonly closed: boolean;
}

export interface DurableStreamLog {
	/** PUT: create the stream if absent (idempotent). */
	ensure(path: string, signal?: AbortSignal): Promise<{ readonly nextOffset: StreamOffset }>;
	/** POST: append `messages` (non-empty) atomically under one offset. */
	append(
		path: string,
		messages: readonly unknown[],
		signal?: AbortSignal,
	): Promise<{ readonly nextOffset: StreamOffset }>;
	/** Messages strictly after `from`; `STREAM_START` reads from the beginning. */
	read(
		path: string,
		from: StreamOffset,
		options?: { readonly signal?: AbortSignal },
	): Promise<ReadBatch>;
	/** HEAD: `null` when the stream does not exist. */
	head(
		path: string,
		signal?: AbortSignal,
	): Promise<{ readonly nextOffset: StreamOffset; readonly closed: boolean } | null>;
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
	/** 400: malformed request, e.g. an empty append. */
	| 'bad-request'
	/** 413: the append is larger than the server accepts. */
	| 'payload-too-large'
	/** Network failure, 5xx or 429: retrying the identical request may succeed. */
	| 'unavailable'
	/** The server answered outside the protocol (missing headers, unparseable body). */
	| 'protocol';

/** A failure of a {@link DurableStreamLog} operation. */
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

/** The JSON body of one append: a non-empty array, flattened one level into messages (PROTOCOL §9.1.2). */
export function serializeMessages(path: string, messages: readonly unknown[]): string {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new DurableStreamLogError({
			code: 'bad-request',
			path,
			status: 400,
			message: 'An append needs at least one message.',
		});
	}
	return JSON.stringify(messages);
}
