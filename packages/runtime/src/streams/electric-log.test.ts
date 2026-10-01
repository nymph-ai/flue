/**
 * `ElectricDurableStreamLog` against:
 *
 * 1. `FakeDurableStreamsServer` — a `fetch` that replays the code paths of the
 *    Node reference server (`@durable-streams/server` 0.3.x, `src/server.ts`
 *    `handleCreate`/`handleAppend`/`handleRead`/`handleHead`/`handleSSE` and
 *    `src/store.ts` `append`/`validateProducer`): the same statuses, headers
 *    and bodies, including where the Node and Rust servers differ.
 * 2. Canned responses for the mapping edge cases.
 * 3. A real server, when `FLUE_DS_URL` is set to its stream root (skipped
 *    otherwise). `scripts/test-durable-streams-server.sh` installs and starts
 *    `@durable-streams/server` outside the workspace, plus a webhook receiver
 *    (`FLUE_DS_WEBHOOK_URL`, `FLUE_DS_WEBHOOK_CAPTURE_URL`), then runs this file:
 *
 *    ```sh
 *    pnpm --filter @flue/runtime exec bash scripts/test-durable-streams-server.sh
 *    ```
 */
import { describe, expect, it } from 'vitest';
import {
	jwksWebhookKeys,
	parseWebhookBody,
	verifyWebhookSignature,
	webhookJwksUrl,
} from '../entity/webhook.ts';
import { defineDurableStreamLogContractTests } from '../test-utils/define-durable-stream-log-contract-tests.ts';
import { ElectricDurableStreamLog } from './electric-log.ts';
import { DurableStreamLogError } from './log.ts';
import { asStreamOffset, STREAM_START } from './offset.ts';

// ─── Fake server ────────────────────────────────────────────────────────────

interface FakeProducer {
	epoch: number;
	lastSeq: number;
}

interface FakeStream {
	contentType: string;
	closed: boolean;
	/** One stored unit per POST: the values it flattened into, and its offset. */
	messages: { offset: string; values: unknown[] }[];
	currentOffset: string;
	bytes: number;
	producers: Map<string, FakeProducer>;
	lastSeq?: string;
}

const ZERO_OFFSET = '0000000000000000_0000000000000000';

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

function empty(status: number, headers: Record<string, string>): Response {
	return new Response(null, { status, headers });
}

function abortError(): DOMException {
	return new DOMException('The operation was aborted.', 'AbortError');
}

class FakeDurableStreamsServer {
	readonly streams = new Map<string, FakeStream>();
	readonly requests: { method: string; url: string; headers: Headers }[] = [];
	private waiters = new Set<{ path: string; wake: () => void }>();

	constructor(
		readonly origin = 'http://ds.test',
		private readonly longPollTimeoutMs = 200,
	) {}

	readonly fetch = async (input: Request | string | URL, init: RequestInit = {}) => {
		const request = new Request(input, init);
		this.requests.push({ method: request.method, url: request.url, headers: request.headers });
		const url = new URL(request.url);
		const path = decodeURIComponent(url.pathname);
		switch (request.method) {
			case 'PUT':
				return this.create(path, request);
			case 'HEAD':
				return this.head(path);
			case 'POST':
				return this.append(path, request);
			case 'GET':
				return this.read(path, url, init.signal ?? undefined);
			default:
				return text(405, 'Method not allowed');
		}
	};

	private create(path: string, request: Request): Response {
		const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
		const closed = request.headers.get('stream-closed') === 'true';
		const existing = this.streams.get(path);
		if (existing) {
			if (existing.contentType !== contentType || existing.closed !== closed) {
				return text(409, 'Stream already exists with different configuration');
			}
			return empty(200, {
				'content-type': existing.contentType,
				'Stream-Next-Offset': existing.currentOffset,
			});
		}
		this.streams.set(path, {
			contentType,
			closed,
			messages: [],
			currentOffset: ZERO_OFFSET,
			bytes: 0,
			producers: new Map(),
		});
		return empty(201, {
			'content-type': contentType,
			'Stream-Next-Offset': ZERO_OFFSET,
			location: `${this.origin}${path}`,
		});
	}

	private head(path: string): Response {
		const stream = this.streams.get(path);
		if (!stream) return empty(404, { 'content-type': 'text/plain' });
		return empty(200, {
			'Stream-Next-Offset': stream.currentOffset,
			'cache-control': 'no-store',
			'content-type': stream.contentType,
			...(stream.closed ? { 'Stream-Closed': 'true' } : {}),
		});
	}

	private async append(path: string, request: Request): Promise<Response> {
		const seq = request.headers.get('stream-seq') ?? undefined;
		const producerId = request.headers.get('producer-id');
		const epochText = request.headers.get('producer-epoch');
		const seqText = request.headers.get('producer-seq');
		const some = producerId !== null || epochText !== null || seqText !== null;
		const all = producerId !== null && epochText !== null && seqText !== null;
		if (some && !all) {
			return text(
				400,
				'All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together',
			);
		}
		if (all && producerId === '') return text(400, 'Invalid Producer-Id: must not be empty');
		if (all && !/^\d+$/.test(epochText as string)) {
			return text(400, 'Invalid Producer-Epoch: must be a non-negative integer');
		}
		if (all && !/^\d+$/.test(seqText as string)) {
			return text(400, 'Invalid Producer-Seq: must be a non-negative integer');
		}
		const body = await request.text();
		if (body.length === 0) return text(400, 'Empty body');
		const contentType = request.headers.get('content-type');
		if (!contentType) return text(400, 'Content-Type header is required');
		const stream = this.streams.get(path);
		if (!stream) return text(404, 'Stream not found');
		if (stream.closed) {
			return text(409, 'Stream is closed', {
				'Stream-Closed': 'true',
				'Stream-Next-Offset': stream.currentOffset,
			});
		}
		if (contentType.split(';')[0]?.trim() !== stream.contentType) {
			return text(409, 'Content-type mismatch');
		}
		let next: FakeProducer | undefined;
		if (all) {
			const epoch = Number(epochText);
			const producerSeq = Number(seqText);
			const state = stream.producers.get(producerId as string);
			if (!state) {
				if (producerSeq !== 0) {
					return text(409, 'Producer sequence gap', {
						'Producer-Expected-Seq': '0',
						'Producer-Received-Seq': String(producerSeq),
					});
				}
				next = { epoch, lastSeq: 0 };
			} else if (epoch < state.epoch) {
				return text(403, 'Stale producer epoch', { 'Producer-Epoch': String(state.epoch) });
			} else if (epoch > state.epoch) {
				if (producerSeq !== 0) return text(400, 'New epoch must start with sequence 0');
				next = { epoch, lastSeq: 0 };
			} else if (producerSeq <= state.lastSeq) {
				// Node: no Stream-Next-Offset on a duplicate.
				return empty(204, {
					'Producer-Epoch': String(epoch),
					'Producer-Seq': String(state.lastSeq),
				});
			} else if (producerSeq === state.lastSeq + 1) {
				next = { epoch, lastSeq: producerSeq };
			} else {
				return text(409, 'Producer sequence gap', {
					'Producer-Expected-Seq': String(state.lastSeq + 1),
					'Producer-Received-Seq': String(producerSeq),
				});
			}
		}
		// Stream-Seq AFTER producer validation; producer state is committed
		// only after this passes.
		if (seq !== undefined && stream.lastSeq !== undefined && seq <= stream.lastSeq) {
			return text(409, 'Sequence conflict');
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return text(400, 'Invalid JSON');
		}
		const values = Array.isArray(parsed) ? parsed : [parsed];
		if (Array.isArray(parsed) && parsed.length === 0) {
			return text(400, 'Empty arrays are not allowed');
		}
		const stored = values.map((value) => `${JSON.stringify(value)},`).join('');
		stream.bytes += 5 + new TextEncoder().encode(stored).length;
		const offset = `${'0'.repeat(16)}_${String(stream.bytes).padStart(16, '0')}`;
		stream.messages.push({ offset, values });
		stream.currentOffset = offset;
		if (all && next) stream.producers.set(producerId as string, next);
		if (seq !== undefined) stream.lastSeq = seq;
		for (const waiter of [...this.waiters]) if (waiter.path === path) waiter.wake();
		return empty(all ? 200 : 204, {
			'Stream-Next-Offset': offset,
			...(all ? { 'Producer-Epoch': epochText as string, 'Producer-Seq': seqText as string } : {}),
		});
	}

	private after(stream: FakeStream, offset: string | undefined): FakeStream['messages'] {
		if (offset === undefined || offset === '-1') return [...stream.messages];
		return stream.messages.filter((message) => message.offset > offset);
	}

	private waitForAppend(
		path: string,
		signal: AbortSignal | undefined,
	): Promise<'data' | 'timeout'> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(abortError());
				return;
			}
			const waiter = { path, wake: () => finish('data') };
			const timer = setTimeout(() => finish('timeout'), this.longPollTimeoutMs);
			const onAbort = () => {
				clearTimeout(timer);
				this.waiters.delete(waiter);
				reject(abortError());
			};
			const finish = (outcome: 'data' | 'timeout') => {
				clearTimeout(timer);
				this.waiters.delete(waiter);
				signal?.removeEventListener('abort', onAbort);
				resolve(outcome);
			};
			this.waiters.add(waiter);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}

	private async read(path: string, url: URL, signal: AbortSignal | undefined): Promise<Response> {
		const stream = this.streams.get(path);
		if (!stream) return text(404, 'Stream not found');
		const offset = url.searchParams.get('offset') ?? undefined;
		const live = url.searchParams.get('live');
		if (offset !== undefined) {
			if (offset === '') return text(400, 'Empty offset parameter');
			if (url.searchParams.getAll('offset').length > 1) {
				return text(400, 'Multiple offset parameters not allowed');
			}
			if (!/^(-1|now|\d+_\d+)$/.test(offset)) return text(400, 'Invalid offset format');
		}
		if ((live === 'long-poll' || live === 'sse') && !offset) {
			return text(400, `${live === 'sse' ? 'SSE' : 'Long-poll'} requires offset parameter`);
		}
		if (live === 'sse') {
			return this.sse(
				path,
				stream,
				offset === 'now' ? stream.currentOffset : (offset as string),
				signal,
			);
		}
		const effective = offset === 'now' ? stream.currentOffset : offset;
		if (offset === 'now' && live !== 'long-poll') {
			return new Response('[]', {
				status: 200,
				headers: {
					'Stream-Next-Offset': stream.currentOffset,
					'Stream-Up-To-Date': 'true',
					'cache-control': 'no-store',
					'content-type': stream.contentType,
				},
			});
		}
		let messages = this.after(stream, effective);
		const caughtUp = (effective && effective === stream.currentOffset) || offset === 'now';
		if (live === 'long-poll' && caughtUp && messages.length === 0) {
			const outcome = await this.waitForAppend(path, signal);
			if (outcome === 'timeout') {
				return empty(204, {
					'Stream-Next-Offset': effective ?? stream.currentOffset,
					'Stream-Up-To-Date': 'true',
					'Stream-Cursor': '1000',
				});
			}
			messages = this.after(stream, effective);
		}
		const responseOffset = messages.at(-1)?.offset ?? stream.currentOffset;
		return new Response(JSON.stringify(messages.flatMap((message) => message.values)), {
			status: 200,
			headers: {
				'content-type': stream.contentType,
				'Stream-Next-Offset': responseOffset,
				'Stream-Up-To-Date': 'true',
				...(live === 'long-poll' ? { 'Stream-Cursor': '1000' } : {}),
			},
		});
	}

	private sse(
		path: string,
		stream: FakeStream,
		initialOffset: string,
		signal: AbortSignal | undefined,
	): Response {
		const encoder = new TextEncoder();
		const frame = (event: string, payload: string) =>
			encoder.encode(
				`event: ${event}\n${payload
					.split(/\r\n|\r|\n/)
					.map((line) => `data:${line}`)
					.join('\n')}\n\n`,
			);
		let current = initialOffset;
		const body = new ReadableStream<Uint8Array>({
			pull: async (controller) => {
				try {
					const messages = this.after(stream, current);
					if (messages.length > 0) {
						// Pretty-printed across lines, as a multi-line `data:` event.
						controller.enqueue(
							frame(
								'data',
								JSON.stringify(
									messages.flatMap((message) => message.values),
									null,
									1,
								),
							),
						);
						current = messages.at(-1)?.offset as string;
					}
					controller.enqueue(
						frame(
							'control',
							JSON.stringify({
								streamNextOffset: messages.at(-1)?.offset ?? stream.currentOffset,
								streamCursor: '1000',
								upToDate: true,
							}),
						),
					);
					current = messages.at(-1)?.offset ?? stream.currentOffset;
					await this.waitForAppend(path, signal);
				} catch (error) {
					controller.error(error);
				}
			},
		});
		return new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
		});
	}
}

// ─── Contract ───────────────────────────────────────────────────────────────

defineDurableStreamLogContractTests('ElectricDurableStreamLog (Node reference server paths)', {
	create: () => {
		const server = new FakeDurableStreamsServer();
		return new ElectricDurableStreamLog({
			baseUrl: `${server.origin}/v1/stream`,
			fetch: server.fetch,
		});
	},
});

const env =
	(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const realServer = env.FLUE_DS_URL;
const webhookUrl = env.FLUE_DS_WEBHOOK_URL;
const webhookCaptureUrl = env.FLUE_DS_WEBHOOK_CAPTURE_URL;

describe.skipIf(!realServer)('ElectricDurableStreamLog against FLUE_DS_URL', () => {
	defineDurableStreamLogContractTests('real Durable Streams server', {
		create: () => new ElectricDurableStreamLog({ baseUrl: realServer as string }),
		pathPrefix: `flue-contract/${crypto.randomUUID()}/`,
	});

	it.skipIf(!webhookUrl || !webhookCaptureUrl)(
		'delivers a signed wake that the webhook verifier accepts',
		async () => {
			const root = realServer as string;
			const prefix = `flue-hooks-${crypto.randomUUID().slice(0, 8)}`;
			const subscription = await fetch(`${root}/__ds/subscriptions/${prefix}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					type: 'webhook',
					pattern: `${prefix}/*`,
					webhook: { url: webhookUrl },
				}),
			});
			if (subscription.status !== 200 && subscription.status !== 201) {
				throw new Error(
					`subscription PUT: ${subscription.status} ${await subscription.text()} (webhook subscriptions need the server's \`webhooks: true\`)`,
				);
			}
			const log = new ElectricDurableStreamLog({ baseUrl: root });
			const inbox = `${prefix}/inbox`;
			await log.ensure(inbox);
			const appended = await log.append(inbox, [{ from: 'alice', text: 'hi' }]);

			let captured: { header: string | null; body: string } | undefined;
			for (let attempt = 0; attempt < 100 && !captured; attempt++) {
				const response = await fetch(webhookCaptureUrl as string);
				const value = response.ok
					? ((await response.json()) as { header: string | null; body: string })
					: undefined;
				if (value?.body.includes(prefix)) captured = value;
				else await new Promise((resolve) => setTimeout(resolve, 50));
			}
			if (!captured) throw new Error('no webhook delivery captured');

			const keys = jwksWebhookKeys({ url: webhookJwksUrl(root) });
			expect(
				await verifyWebhookSignature({ body: captured.body, header: captured.header, keys }),
			).toMatchObject({ ok: true });
			expect(
				(
					await verifyWebhookSignature({
						body: `${captured.body} `,
						header: captured.header,
						keys,
					})
				).ok,
			).toBe(false);
			const wake = parseWebhookBody(captured.body);
			expect(wake.subscription_id).toBe(prefix);
			expect(wake.streams.find((stream) => stream.path === inbox)).toMatchObject({
				tail_offset: appended.nextOffset,
				has_pending: true,
			});
		},
	);
});

// ─── Mapping ────────────────────────────────────────────────────────────────

function canned(respond: (request: Request) => Response | Promise<Response>): {
	log: ElectricDurableStreamLog;
	seen: Request[];
} {
	const seen: Request[] = [];
	const log = new ElectricDurableStreamLog({
		baseUrl: 'https://ds.test/v1/stream/',
		fetch: async (input, init) => {
			const request = new Request(input, init);
			seen.push(request);
			return respond(request);
		},
		headers: async () => ({ authorization: 'Bearer secret' }),
	});
	return { log, seen };
}

describe('ElectricDurableStreamLog request shape', () => {
	it('POSTs a plain JSON array, with no producer headers', async () => {
		const { log, seen } = canned(() =>
			empty(200, { 'Stream-Next-Offset': '0000000000000000_0000000000000042' }),
		);
		const outcome = await log.append('flue/v1/a b/i/inbox', [{ type: 'flue.a2a.message' }]);
		expect(outcome).toEqual({ nextOffset: '0000000000000000_0000000000000042' });
		const request = seen[0] as Request;
		expect(request.method).toBe('POST');
		expect(request.url).toBe('https://ds.test/v1/stream/flue/v1/a%20b/i/inbox');
		expect(request.headers.get('content-type')).toBe('application/json');
		expect(request.headers.get('producer-id')).toBeNull();
		expect(request.headers.get('stream-seq')).toBeNull();
		expect(request.headers.get('authorization')).toBe('Bearer secret');
		expect(await request.json()).toEqual([{ type: 'flue.a2a.message' }]);
	});

	it('reads with only the offset query parameter', async () => {
		const { log, seen } = canned(
			() =>
				new Response('[{"a":1}]', {
					headers: { 'Stream-Next-Offset': 'x_2', 'Stream-Up-To-Date': 'TRUE' },
				}),
		);
		const batch = await log.read('s', asStreamOffset('x_1'));
		expect(batch).toEqual({
			messages: [{ a: 1 }],
			nextOffset: 'x_2',
			upToDate: true,
			closed: false,
		});
		const url = new URL((seen[0] as Request).url);
		expect(Object.fromEntries(url.searchParams)).toEqual({ offset: 'x_1' });
	});
});

describe('ElectricDurableStreamLog status mapping', () => {
	const append = (response: () => Response) => canned(response).log.append('s', [1]);

	it('accepts both success statuses', async () => {
		expect(await append(() => empty(204, { 'Stream-Next-Offset': 'o_9' }))).toEqual({
			nextOffset: 'o_9',
		});
		expect(await append(() => empty(200, { 'Stream-Next-Offset': 'o_9' }))).toEqual({
			nextOffset: 'o_9',
		});
	});

	it('maps transport failures, 429 and 5xx to retryable errors', async () => {
		for (const status of [429, 500, 502, 503]) {
			const error = await append(() => text(status, 'busy')).catch((caught: unknown) => caught);
			expect((error as DurableStreamLogError).retryable).toBe(true);
		}
		const { log } = canned(() => {
			throw new TypeError('fetch failed');
		});
		await expect(log.append('s', [1])).rejects.toMatchObject({ code: 'unavailable' });
	});

	it('throws typed errors for closed, conflicting, oversized and missing streams', async () => {
		await expect(
			append(() =>
				text(409, 'Stream is closed', { 'Stream-Closed': 'true', 'Stream-Next-Offset': 'o' }),
			),
		).rejects.toMatchObject({ code: 'closed' });
		await expect(append(() => text(409, 'Content-type mismatch'))).rejects.toMatchObject({
			code: 'conflict',
		});
		await expect(append(() => text(413, 'too large'))).rejects.toMatchObject({
			code: 'payload-too-large',
		});
		await expect(append(() => text(404, 'Stream not found'))).rejects.toMatchObject({
			code: 'not-found',
		});
		await expect(append(() => text(410, 'Stream is gone'))).rejects.toMatchObject({ code: 'gone' });
		await expect(append(() => text(400, 'Empty body'))).rejects.toMatchObject({
			code: 'bad-request',
		});
		await expect(append(() => empty(200, {}))).rejects.toMatchObject({ code: 'protocol' });
	});

	it('maps PUT conflicts and transient failures to typed errors', async () => {
		const conflict = canned(() => text(409, 'Stream already exists with different configuration'));
		await expect(conflict.log.ensure('s')).rejects.toMatchObject({ code: 'conflict' });
		const down = canned(() => text(503, 'unavailable'));
		const error = await down.log.ensure('s').catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DurableStreamLogError);
		expect((error as DurableStreamLogError).retryable).toBe(true);
		const created = canned(() => empty(201, { 'Stream-Next-Offset': ZERO_OFFSET }));
		expect(await created.log.ensure('s')).toEqual({ nextOffset: ZERO_OFFSET });
		expect((created.seen[0] as Request).method).toBe('PUT');
		expect((created.seen[0] as Request).headers.get('content-type')).toBe('application/json');
	});

	it('maps HEAD and missing streams', async () => {
		const closed = canned(() =>
			empty(200, { 'Stream-Next-Offset': 'o_5', 'Stream-Closed': 'true' }),
		);
		expect(await closed.log.head('s')).toEqual({ nextOffset: 'o_5', closed: true });
		const missing = canned(() => empty(404, {}));
		expect(await missing.log.head('s')).toBeNull();
		await expect(missing.log.read('s', STREAM_START)).rejects.toMatchObject({
			code: 'not-found',
		});
	});
});
