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
 * | POST | 200, 204 | `{ nextOffset }` |
 * | any | 409 + `Stream-Closed: true` | `closed` error |
 * | any | 409 otherwise | `conflict` error |
 * | any | 400 / 404 / 410 / 413 | `bad-request` / `not-found` / `gone` / `payload-too-large` |
 * | any | network, 408, 425, 429, 5xx | `unavailable` error (`retryable === true`) |
 *
 * Only catch-up reads: no long-poll, no SSE, nothing held open (rule 8).
 */

import {
	type DurableStreamLog,
	DurableStreamLogError,
	type ReadBatch,
	serializeMessages,
} from './log.ts';
import { asStreamOffset, type StreamOffset } from './offset.ts';

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
	return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function headerTrue(response: Response, name: string): boolean {
	return response.headers.get(name)?.toLowerCase() === 'true';
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

	async ensure(path: string, signal?: AbortSignal): Promise<{ readonly nextOffset: StreamOffset }> {
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
		messages: readonly unknown[],
		signal?: AbortSignal,
	): Promise<{ readonly nextOffset: StreamOffset }> {
		// A JSON array body is flattened one level into messages (§9.1.2),
		// so `messages` land exactly as given, atomically, under one offset.
		const body = serializeMessages(path, messages);
		const response = await this.request(path, this.streamUrl(path), {
			method: 'POST',
			headers: { 'content-type': JSON_CONTENT_TYPE },
			body,
			signal,
		});
		if (response.status === 200 || response.status === 204) {
			await bodyText(response);
			return { nextOffset: this.requireOffset(path, response) };
		}
		throw await this.failure(path, response);
	}

	async read(
		path: string,
		from: StreamOffset,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<ReadBatch> {
		const url = new URL(this.streamUrl(path));
		url.searchParams.set('offset', from);
		const response = await this.request(path, url.toString(), {
			method: 'GET',
			signal: options.signal,
		});
		if (response.status !== 200) throw await this.failure(path, response);
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
		return {
			messages,
			nextOffset: this.requireOffset(path, response),
			upToDate: headerTrue(response, 'Stream-Up-To-Date'),
			closed: headerTrue(response, 'Stream-Closed'),
		};
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
		init: {
			method: string;
			headers?: HeaderRecord;
			body?: string;
			signal?: AbortSignal | undefined;
		},
	): Promise<Response> {
		try {
			return await this.fetchImpl(url, {
				method: init.method,
				headers: { ...(await this.resolveHeaders()), ...init.headers },
				...(init.body !== undefined ? { body: init.body } : {}),
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
		if (status === 410)
			return new DurableStreamLogError({ code: 'gone', path, status, message: detail });
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
