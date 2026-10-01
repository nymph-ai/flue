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
 * - a read after the tail returns nothing, up to date, at the tail.
 *
 * `onAppend` observes every append (tests, and a Node process that rings its
 * own entities' doorbells in-process).
 */

import {
	type DurableStreamLog,
	DurableStreamLogError,
	type ReadBatch,
	serializeMessages,
} from './log.ts';
import { asStreamOffset, compareOffsets, STREAM_START, type StreamOffset } from './offset.ts';

export interface InMemoryDurableStreamLogOptions {
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
	private readonly maxReadMessages: number | undefined;
	private readonly appendListeners = new Set<(path: string, nextOffset: StreamOffset) => void>();

	constructor(options: InMemoryDurableStreamLogOptions = {}) {
		this.maxReadMessages = options.maxReadMessages;
	}

	/** Observe every append: `(path, nextOffset)`. Returns the unsubscribe. */
	onAppend(listener: (path: string, nextOffset: StreamOffset) => void): () => void {
		this.appendListeners.add(listener);
		return () => this.appendListeners.delete(listener);
	}

	async ensure(path: string): Promise<{ readonly nextOffset: StreamOffset }> {
		let stream = this.streams.get(path);
		if (!stream) {
			stream = { appends: [], tail: mintOffset(0), bytes: 0 };
			this.streams.set(path, stream);
		}
		return { nextOffset: stream.tail };
	}

	async append(
		path: string,
		messages: readonly unknown[],
	): Promise<{ readonly nextOffset: StreamOffset }> {
		const stream = this.require(path);
		const data = serializeMessages(path, messages);
		stream.bytes += FRAME_OVERHEAD + encoder.encode(data).length;
		const offset = mintOffset(stream.bytes);
		stream.appends.push({ offset, data, count: messages.length });
		stream.tail = offset;
		for (const listener of [...this.appendListeners]) listener(path, offset);
		return { nextOffset: offset };
	}

	async read(path: string, from: StreamOffset): Promise<ReadBatch> {
		const stream = this.require(path);
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
		return {
			messages: page.flatMap((entry) => JSON.parse(entry.data) as unknown[]),
			nextOffset: page.at(-1)?.offset ?? stream.tail,
			upToDate: page.length === pending.length,
			closed: false,
		};
	}

	async head(
		path: string,
	): Promise<{ readonly nextOffset: StreamOffset; readonly closed: boolean } | null> {
		const stream = this.streams.get(path);
		return stream ? { nextOffset: stream.tail, closed: false } : null;
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
}
