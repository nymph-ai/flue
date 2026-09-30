/**
 * `ElectricDurableStreamLog` — {@link DurableStreamLog} over the Durable
 * Streams HTTP protocol (PROTOCOL.md §5), as served by Electric's
 * agents-server (which embeds `@durable-streams/server`) and by
 * `durable-streams-rust`. Streams are `application/json` (§9.1). Only `fetch`
 * and web streams are used, so it runs on workerd.
 *
 * Status mapping, taken from the reference servers' code paths:
 *
 * | Request | Status | Result |
 * |---|---|---|
 * | PUT | 201, 200 | `{ nextOffset }` from `Stream-Next-Offset` |
 * | PUT | 409 | `conflict` error (existing stream, different config) |
 * | POST | 200 | `appended`, `Stream-Next-Offset` |
 * | POST | 204 | `duplicate` (`Stream-Next-Offset` only from the Rust server) |
 * | POST | 403 | `fenced`, `currentEpoch` from `Producer-Epoch` |
 * | POST | 409 + `Producer-Expected-Seq` | `producer-gap` |
 * | POST | 409 + `Stream-Closed: true` | `closed` error |
 * | POST | 409, body mentions "sequence" | `stream-seq-conflict` (body is exactly "Sequence conflict" on both servers) |
 * | POST | 409 otherwise | `conflict` error (content-type mismatch) |
 * | POST | 400 | `bad-request` error (e.g. a new epoch not at seq 0) |
 * | POST | 413 | `payload-too-large` error — split the append |
 * | any | 404 / 410 | `not-found` / `gone` error |
 * | POST | network, 408, 425, 429, 5xx | `retryable` |
 * | other | network, 408, 425, 429, 5xx | `unavailable` error (`retryable === true`) |
 * | GET long-poll | 204 | empty batch at `Stream-Next-Offset` (timeout) |
 */

import {
	type AppendOutcome,
	type DurableStreamLog,
	DurableStreamLogError,
	type ProducerClaim,
	type ReadBatch,
} from './log.ts';
import { asStreamOffset, type StreamOffset } from './offset.ts';
import { assertProducerClaim, serializeMessages } from './producer-fence.ts';

type HeaderRecord = Readonly<Record<string, string>>;

export interface ElectricDurableStreamLogOptions {
	/**
	 * The stream root: stream `path` is served at `${baseUrl}/${path}`, e.g.
	 * `https://streams.example/v1/stream` for the Node server's default root.
	 */
	readonly baseUrl: string;
	/** Defaults to the global `fetch`. */
	readonly fetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
	/** Extra headers on every request (auth); a function is evaluated per request. */
	readonly headers?: HeaderRecord | (() => HeaderRecord | Promise<HeaderRecord>);
}

const JSON_CONTENT_TYPE = 'application/json';

/** Statuses after which the identical request may succeed. */
function isTransientStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
	return (
		signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
	);
}

function headerTrue(response: Response, name: string): boolean {
	return response.headers.get(name)?.toLowerCase() === 'true';
}

function integerHeader(response: Response, name: string): number | undefined {
	const raw = response.headers.get(name);
	if (raw === null || !/^\d+$/.test(raw)) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : undefined;
}

async function bodyText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

export class ElectricDurableStreamLog implements DurableStreamLog {
	private readonly baseUrl: string;
	private readonly fetchImpl: NonNullable<ElectricDurableStreamLogOptions['fetch']>;
	private readonly extraHeaders: ElectricDurableStreamLogOptions['headers'];

	constructor(options: ElectricDurableStreamLogOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		// Never call an unbound global fetch: workerd rejects it.
		this.fetchImpl =
			options.fetch ?? ((input: Request | string | URL, init?: RequestInit) => fetch(input, init));
		this.extraHeaders = options.headers;
	}

	/** The URL of one stream; each path segment is percent-encoded. */
	streamUrl(path: string): string {
		const segments = path
			.split('/')
			.filter((segment) => segment.length > 0)
			.map((segment) => encodeURIComponent(segment));
		return `${this.baseUrl}/${segments.join('/')}`;
	}

	async ensure(
		path: string,
		signal?: AbortSignal,
	): Promise<{ readonly nextOffset: StreamOffset }> {
		const response = await this.request(path, this.streamUrl(path), {
			method: 'PUT',
			headers: { 'content-type': JSON_CONTENT_TYPE },
			signal,
		});
		if (response.status === 200 || response.status === 201) {
			await bodyText(response);
			return { nextOffset: this.requireOffset(path, response) };
		}
		throw await this.failure(path, response);
	}

	async append(
		path: string,
		input: {
			readonly messages: readonly unknown[];
			readonly producer: ProducerClaim;
			readonly streamSeq?: string;
		},
		signal?: AbortSignal,
	): Promise<AppendOutcome> {
		assertProducerClaim(path, input.producer);
		// A JSON array body is flattened one level into messages (§9.1.2),
		// so `messages` land exactly as given, atomically, under one offset.
		const body = serializeMessages(path, input.messages);
		let response: Response;
		try {
			response = await this.fetchImpl(this.streamUrl(path), {
				method: 'POST',
				headers: {
					...(await this.resolveHeaders()),
					'content-type': JSON_CONTENT_TYPE,
					'Producer-Id': input.producer.id,
					'Producer-Epoch': String(input.producer.epoch),
					'Producer-Seq': String(input.producer.seq),
					...(input.streamSeq === undefined ? {} : { 'Stream-Seq': input.streamSeq }),
				},
				body,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			if (isAbort(error, signal)) throw error;
			return { status: 'retryable', error };
		}
		const nextOffset = response.headers.get('Stream-Next-Offset');
		switch (response.status) {
			case 200:
				await bodyText(response);
				return { status: 'appended', nextOffset: this.requireOffset(path, response) };
			case 204:
				return nextOffset === null
					? { status: 'duplicate' }
					: { status: 'duplicate', nextOffset: asStreamOffset(nextOffset) };
			case 403: {
				await bodyText(response);
				const currentEpoch = integerHeader(response, 'Producer-Epoch');
				if (currentEpoch === undefined) {
					throw this.protocol(path, 403, 'A 403 carried no valid Producer-Epoch header.');
				}
				return { status: 'fenced', currentEpoch };
			}
			case 409: {
				const text = await bodyText(response);
				const expectedSeq = integerHeader(response, 'Producer-Expected-Seq');
				if (expectedSeq !== undefined) return { status: 'producer-gap', expectedSeq };
				if (headerTrue(response, 'Stream-Closed')) {
					throw new DurableStreamLogError({
						code: 'closed',
						path,
						status: 409,
						message: 'The stream is closed.',
					});
				}
				if (/sequence/i.test(text)) {
					return nextOffset === null
						? { status: 'stream-seq-conflict' }
						: { status: 'stream-seq-conflict', nextOffset: asStreamOffset(nextOffset) };
				}
				throw new DurableStreamLogError({
					code: 'conflict',
					path,
					status: 409,
					message: text || 'Append conflicts with the stream.',
				});
			}
			default:
				if (isTransientStatus(response.status)) {
					return { status: 'retryable', error: await this.failure(path, response) };
				}
				throw await this.failure(path, response);
		}
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
		const url = new URL(this.streamUrl(path));
		url.searchParams.set('offset', from);
		if (options.live) url.searchParams.set('live', options.live);
		if (options.cursor !== undefined) url.searchParams.set('cursor', options.cursor);
		const response = await this.request(path, url.toString(), {
			method: 'GET',
			headers: options.live === 'sse' ? { accept: 'text/event-stream' } : {},
			signal: options.signal,
		});
		if (response.status === 204) {
			// Long-poll timeout (§5.7): caught up, nothing new.
			return this.batchFromHeaders(path, response, []);
		}
		if (response.status !== 200) throw await this.failure(path, response);
		if (options.live === 'sse') return this.readSse(path, response, from);
		const text = await response.text();
		let messages: unknown;
		try {
			messages = text.length === 0 ? [] : JSON.parse(text);
		} catch (cause) {
			throw this.protocol(path, 200, 'Read body is not JSON.', cause);
		}
		if (!Array.isArray(messages)) {
			throw this.protocol(path, 200, 'Read body is not a JSON array (PROTOCOL §9.1.5).');
		}
		return this.batchFromHeaders(path, response, messages);
	}

	async head(
		path: string,
		signal?: AbortSignal,
	): Promise<{ readonly nextOffset: StreamOffset; readonly closed: boolean } | null> {
		const response = await this.request(path, this.streamUrl(path), { method: 'HEAD', signal });
		if (response.status === 404) {
			await bodyText(response);
			return null;
		}
		if (response.status !== 200) throw await this.failure(path, response);
		await bodyText(response);
		return {
			nextOffset: this.requireOffset(path, response),
			closed: headerTrue(response, 'Stream-Closed'),
		};
	}

	private async resolveHeaders(): Promise<HeaderRecord> {
		const headers = this.extraHeaders;
		if (!headers) return {};
		return typeof headers === 'function' ? await headers() : headers;
	}

	/** Send a request whose network failure is an `unavailable` error (aborts propagate). */
	private async request(
		path: string,
		url: string,
		init: { method: string; headers?: HeaderRecord; signal?: AbortSignal | undefined },
	): Promise<Response> {
		try {
			return await this.fetchImpl(url, {
				method: init.method,
				headers: { ...(await this.resolveHeaders()), ...init.headers },
				...(init.signal ? { signal: init.signal } : {}),
			});
		} catch (error) {
			if (isAbort(error, init.signal)) throw error;
			throw new DurableStreamLogError({
				code: 'unavailable',
				path,
				message: `${init.method} failed: ${error instanceof Error ? error.message : String(error)}`,
				cause: error,
			});
		}
	}

	private batchFromHeaders(path: string, response: Response, messages: unknown[]): ReadBatch {
		const cursor = response.headers.get('Stream-Cursor');
		return {
			messages,
			nextOffset: this.requireOffset(path, response),
			upToDate: headerTrue(response, 'Stream-Up-To-Date'),
			closed: headerTrue(response, 'Stream-Closed'),
			...(cursor === null ? {} : { cursor }),
		};
	}

	/**
	 * One SSE connection yields one batch (§5.8): every `data` event up to the
	 * first `control` event that follows data (or closes the stream). A
	 * data-less `control` (initial position, keep-alive) only updates the
	 * position, so the call waits for data like a long-poll. The connection
	 * is closed once the batch is complete; the caller resumes from its
	 * `nextOffset` and `cursor`.
	 */
	private async readSse(path: string, response: Response, from: StreamOffset): Promise<ReadBatch> {
		if (response.headers.get('stream-sse-data-encoding')?.toLowerCase() === 'base64') {
			await response.body?.cancel();
			throw this.protocol(path, 200, 'Base64 SSE data is only used for non-JSON streams.');
		}
		const body = response.body;
		if (!body) throw this.protocol(path, 200, 'SSE response has no body.');
		const reader = body.getReader();
		const decoder = new TextDecoder();
		const messages: unknown[] = [];
		let nextOffset: StreamOffset | undefined;
		let cursor: string | undefined;
		let upToDate = false;
		let closed = false;
		let buffer = '';
		let event = 'message';
		let data: string[] = [];
		// Returns true once the batch is complete.
		const dispatch = (): boolean => {
			const payload = data.join('\n');
			const name = event;
			event = 'message';
			data = [];
			if (name === 'data') {
				let parsed: unknown;
				try {
					parsed = JSON.parse(payload);
				} catch (cause) {
					throw this.protocol(path, 200, 'SSE data event is not JSON.', cause);
				}
				if (!Array.isArray(parsed)) {
					throw this.protocol(path, 200, 'SSE data event is not a JSON array.');
				}
				messages.push(...parsed);
				return false;
			}
			if (name !== 'control') return false;
			let control: {
				streamNextOffset?: unknown;
				streamCursor?: unknown;
				upToDate?: unknown;
				streamClosed?: unknown;
			};
			try {
				control = JSON.parse(payload) as typeof control;
			} catch (cause) {
				throw this.protocol(path, 200, 'SSE control event is not JSON.', cause);
			}
			if (typeof control.streamNextOffset !== 'string') {
				throw this.protocol(path, 200, 'SSE control event has no streamNextOffset.');
			}
			nextOffset = asStreamOffset(control.streamNextOffset);
			if (typeof control.streamCursor === 'string') cursor = control.streamCursor;
			closed = control.streamClosed === true;
			upToDate = closed || control.upToDate === true;
			return messages.length > 0 || closed;
		};
		try {
			while (true) {
				const { value: chunk, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(chunk, { stream: true });
				// A chunk ending in CR may be the first half of a CRLF: hold it
				// back so the LF in the next chunk does not read as a blank line.
				const heldCr = buffer.endsWith('\r');
				const lines = (heldCr ? buffer.slice(0, -1) : buffer).split(/\r\n|\r|\n/);
				buffer = (lines.pop() ?? '') + (heldCr ? '\r' : '');
				for (const line of lines) {
					if (line === '') {
						if (dispatch()) {
							return this.sseBatch(messages, nextOffset, from, upToDate, closed, cursor);
						}
						continue;
					}
					if (line.startsWith(':')) continue;
					const colon = line.indexOf(':');
					const field = colon === -1 ? line : line.slice(0, colon);
					let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
					if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
					if (field === 'event') event = fieldValue;
					else if (field === 'data') data.push(fieldValue);
				}
			}
			// An unterminated trailing event is discarded, per the SSE spec.
			if (nextOffset === undefined) {
				throw this.protocol(path, 200, 'SSE stream ended without a control event.');
			}
			return this.sseBatch(messages, nextOffset, from, upToDate, closed, cursor);
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}

	private sseBatch(
		messages: unknown[],
		nextOffset: StreamOffset | undefined,
		from: StreamOffset,
		upToDate: boolean,
		closed: boolean,
		cursor: string | undefined,
	): ReadBatch {
		return {
			messages,
			nextOffset: nextOffset ?? from,
			upToDate,
			closed,
			...(cursor === undefined ? {} : { cursor }),
		};
	}

	private requireOffset(path: string, response: Response): StreamOffset {
		const offset = response.headers.get('Stream-Next-Offset');
		if (offset === null || offset.length === 0) {
			throw this.protocol(path, response.status, 'Response carried no Stream-Next-Offset.');
		}
		return asStreamOffset(offset);
	}

	private protocol(
		path: string,
		status: number,
		message: string,
		cause?: unknown,
	): DurableStreamLogError {
		return new DurableStreamLogError({ code: 'protocol', path, status, message, cause });
	}

	private async failure(path: string, response: Response): Promise<DurableStreamLogError> {
		const text = (await bodyText(response)).slice(0, 500);
		const status = response.status;
		const detail = text ? `${status} ${text}` : String(status);
		if (status === 404) {
			return new DurableStreamLogError({ code: 'not-found', path, status, message: detail });
		}
		if (status === 410) return new DurableStreamLogError({ code: 'gone', path, status, message: detail });
		if (status === 409) {
			return new DurableStreamLogError({
				code: headerTrue(response, 'Stream-Closed') ? 'closed' : 'conflict',
				path,
				status,
				message: detail,
			});
		}
		if (status === 400) {
			return new DurableStreamLogError({ code: 'bad-request', path, status, message: detail });
		}
		if (status === 413) {
			return new DurableStreamLogError({
				code: 'payload-too-large',
				path,
				status,
				message: `${detail} — split the append.`,
			});
		}
		if (isTransientStatus(status)) {
			return new DurableStreamLogError({ code: 'unavailable', path, status, message: detail });
		}
		return new DurableStreamLogError({
			code: 'protocol',
			path,
			status,
			message: `Unexpected status ${detail}.`,
		});
	}
}
