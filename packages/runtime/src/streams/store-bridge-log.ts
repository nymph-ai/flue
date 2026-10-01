/**
 * `conversationStreamStoreLog(store)` — a {@link DurableStreamLog} over any
 * {@link ConversationStreamStore}, so a Node app keeps its entities' inboxes
 * and events streams in its own persistence adapter (the SQL store, postgres,
 * mysql, libsql, mongodb, redis) when no Electric server is configured. Pi's
 * state never goes here: it lives in each instance's SQLite.
 *
 * Each append is ONE store batch holding ONE record,
 * `{ type: "durable_stream_append", messages }`; the store's all-or-nothing
 * batch contract gives the append its atomicity, and the store's batch
 * offsets are the log's offsets. The store's single-writer fence is held per
 * path and re-acquired when another writer took it; appends to one path are
 * serialized in this process.
 */

import type { ConversationRecord } from '../legacy/conversation-records.ts';
import { ConversationStreamStoreError } from '../errors.ts';
import type {
	ConversationProducerClaim,
	ConversationStreamIdentity,
	ConversationStreamStore,
} from '../runtime/conversation-stream-store.ts';
import {
	type DurableStreamLog,
	DurableStreamLogError,
	type ReadBatch,
	serializeMessages,
} from './log.ts';
import { asStreamOffset, type StreamOffset } from './offset.ts';

export interface ConversationStreamStoreLogOptions {
	/**
	 * The store identity a path's stream is created with. Stores reject a
	 * second create with a different identity, so it must be a pure function
	 * of the path. Default: `{ agentName: "durable-stream-log", instanceId: path }`.
	 */
	readonly identity?: (path: string) => ConversationStreamIdentity;
	/** The store producer id the bridge writes under (default `"durable-stream-log"`). */
	readonly writerId?: string;
}

/** The single record one append is stored as. */
interface AppendEnvelope {
	readonly v: 2;
	readonly type: 'durable_stream_append';
	readonly messages: readonly unknown[];
}

interface PathState {
	claim: ConversationProducerClaim | undefined;
	chain: Promise<unknown>;
}

const APPEND_ATTEMPTS = 8;

function isAppendEnvelope(value: unknown): value is AppendEnvelope {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Partial<AppendEnvelope>;
	return record.type === 'durable_stream_append' && Array.isArray(record.messages);
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

	constructor(
		private readonly store: ConversationStreamStore,
		options: ConversationStreamStoreLogOptions,
	) {
		this.identity =
			options.identity ?? ((path) => ({ agentName: 'durable-stream-log', instanceId: path }));
		this.writerId = options.writerId ?? 'durable-stream-log';
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
		messages: readonly unknown[],
	): Promise<{ readonly nextOffset: StreamOffset }> {
		// Validate before queueing so a bad request never waits.
		serializeMessages(path, messages);
		let state = this.paths.get(path);
		if (!state) {
			state = { claim: undefined, chain: Promise.resolve() };
			this.paths.set(path, state);
		}
		const owner = state;
		const result = owner.chain.then(() => this.appendSerialized(path, owner, messages));
		owner.chain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async appendSerialized(
		path: string,
		state: PathState,
		messages: readonly unknown[],
	): Promise<{ readonly nextOffset: StreamOffset }> {
		let lastError: unknown;
		for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
			try {
				const meta = await this.store.getMeta(path);
				if (!meta) throw this.notFound(path);
				const owned =
					state.claim !== undefined &&
					meta.incarnation === state.claim.incarnation &&
					meta.producerId === state.claim.producerId &&
					meta.producerEpoch === state.claim.producerEpoch;
				if (!owned) state.claim = await this.store.acquireProducer(path, this.writerId);
				const claim = state.claim as ConversationProducerClaim;
				const envelope: AppendEnvelope = { v: 2, type: 'durable_stream_append', messages };
				const { offset } = await this.store.append({
					path,
					producerId: claim.producerId,
					producerEpoch: claim.producerEpoch,
					incarnation: claim.incarnation,
					producerSequence: owned ? meta.nextProducerSequence : claim.nextProducerSequence,
					records: [envelope as unknown as ConversationRecord],
				});
				return { nextOffset: asStreamOffset(offset) };
			} catch (error) {
				if (error instanceof DurableStreamLogError) throw error;
				if (error instanceof ConversationStreamStoreError) {
					// Another writer took the store producer: re-acquire and retry.
					state.claim = undefined;
					lastError = error;
					await new Promise((resolve) => setTimeout(resolve, Math.random() * 5 * (attempt + 1)));
					continue;
				}
				throw this.translate(path, error, 'bad-request');
			}
		}
		throw this.translate(path, lastError, 'conflict');
	}

	async read(path: string, from: StreamOffset): Promise<ReadBatch> {
		const meta = await this.store.getMeta(path);
		if (!meta) throw this.notFound(path);
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

	async head(
		path: string,
	): Promise<{ readonly nextOffset: StreamOffset; readonly closed: boolean } | null> {
		const meta = await this.store.getMeta(path);
		return meta ? { nextOffset: asStreamOffset(meta.nextOffset), closed: false } : null;
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
