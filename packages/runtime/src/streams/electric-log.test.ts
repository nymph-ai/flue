/**
 * `ElectricDurableStreamLog` against:
 *
 * 1. `FakeDurableStreamsServer` (`fake-durable-streams-server.ts`), a `fetch`
 *    that replays the code paths of the Node reference server.
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
import { FakeDurableStreamsServer } from './fake-durable-streams-server.ts';
import { asStreamOffset, STREAM_START } from './offset.ts';

const ZERO_OFFSET = '0000000000000000_0000000000000000';

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

function empty(status: number, headers: Record<string, string>): Response {
	return new Response(null, { status, headers });
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
