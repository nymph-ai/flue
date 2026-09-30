import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../base64.ts';
import {
	acknowledgeWebhookWake,
	jwksWebhookKeys,
	parseWebhookBody,
	parseWebhookSignatureHeader,
	receiveWebhook,
	staticWebhookKeys,
	verifyWebhookSignature,
	type WebhookJwk,
	webhookDoneResponse,
	webhookJwksUrl,
} from './webhook.ts';

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
	return encodeBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * A signing key exactly as the Node reference server builds it
 * (`src/crypto.ts`): an Ed25519 pair, the public JWK with
 * `kid = "ds_" + base64url(sha256('{"crv":"Ed25519","kty":"OKP","x":…}'))`.
 */
async function signingKey(): Promise<{ jwk: WebhookJwk; privateKey: CryptoKey }> {
	const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair;
	const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
	const x = exported.x as string;
	const thumbprint = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })),
	);
	const kid = `ds_${base64Url(new Uint8Array(thumbprint))}`;
	return {
		jwk: { kty: 'OKP', crv: 'Ed25519', x, kid, use: 'sig', alg: 'EdDSA' },
		privateKey: pair.privateKey,
	};
}

/** `signWebhookPayload` from the reference server: `t=<ts>,kid=<kid>,ed25519=<base64url sig>`. */
async function sign(
	key: { jwk: WebhookJwk; privateKey: CryptoKey },
	body: string,
	timestamp: number,
): Promise<string> {
	const signature = await crypto.subtle.sign(
		'Ed25519',
		key.privateKey,
		encoder.encode(`${timestamp}.${body}`),
	);
	return `t=${timestamp},kid=${key.jwk.kid},ed25519=${base64Url(new Uint8Array(signature))}`;
}

const wakeBody = JSON.stringify({
	subscription_id: 'flue-inbox',
	wake_id: 'w_0123456789abcdef01234567',
	generation: 7,
	streams: [
		{
			path: 'flue/v1/support/alice/inbox',
			link_type: 'glob',
			acked_offset: '0000000000000000_0000000000000042',
			tail_offset: '0000000000000000_0000000000000084',
			has_pending: true,
		},
	],
	callback_url: 'https://ds.test/v1/stream/__ds/subscriptions/flue-inbox/callback',
	callback_token: 'eyJ.token',
});

const now = 1_790_000_000;
const clock = () => now * 1000;

describe('webhook signatures', () => {
	it('verifies a reference-server signature against the JWKS', async () => {
		const key = await signingKey();
		const header = await sign(key, wakeBody, now - 10);
		const keys = staticWebhookKeys({ keys: [key.jwk] });
		expect(await verifyWebhookSignature({ body: wakeBody, header, keys, now: clock })).toEqual({
			ok: true,
			timestamp: now - 10,
			kid: key.jwk.kid,
		});
		// Raw bytes verify the same as the string.
		expect(
			(await verifyWebhookSignature({ body: encoder.encode(wakeBody), header, keys, now: clock }))
				.ok,
		).toBe(true);
	});

	it('rejects tampering, replays, unknown keys and malformed headers', async () => {
		const key = await signingKey();
		const other = await signingKey();
		const keys = staticWebhookKeys({ keys: [key.jwk] });
		const header = await sign(key, wakeBody, now);
		const verify = (body: string, value: string | null) =>
			verifyWebhookSignature({ body, header: value, keys, now: clock });

		expect(await verify(`${wakeBody} `, header)).toEqual({ ok: false, reason: 'bad-signature' });
		expect(await verify(wakeBody, await sign(key, wakeBody, now - 301))).toEqual({
			ok: false,
			reason: 'stale-timestamp',
		});
		expect(await verify(wakeBody, await sign(key, wakeBody, now + 301))).toEqual({
			ok: false,
			reason: 'stale-timestamp',
		});
		expect(await verify(wakeBody, await sign(other, wakeBody, now))).toEqual({
			ok: false,
			reason: 'unknown-key',
		});
		// Right kid, wrong signer.
		const forged = (await sign(other, wakeBody, now)).replace(other.jwk.kid, key.jwk.kid);
		expect(await verify(wakeBody, forged)).toEqual({ ok: false, reason: 'bad-signature' });
		// The signature covers the timestamp.
		expect(await verify(wakeBody, header.replace(`t=${now}`, `t=${now - 1}`))).toEqual({
			ok: false,
			reason: 'bad-signature',
		});
		expect(await verify(wakeBody, null)).toEqual({ ok: false, reason: 'missing-signature' });
		for (const malformed of [
			'garbage',
			`t=${now},kid=${key.jwk.kid}`,
			`t=abc,kid=${key.jwk.kid},ed25519=AAAA`,
			`t=${now},kid=${key.jwk.kid},ed25519=not+base64url`,
			`t=${now},kid=${key.jwk.kid},ed25519=AAAA`,
			`t=${now},t=${now},kid=${key.jwk.kid},ed25519=AAAA`,
		]) {
			expect(await verify(wakeBody, malformed)).toEqual({
				ok: false,
				reason: 'malformed-signature',
			});
		}
	});

	it('parses the header in any parameter order', () => {
		const signature = base64Url(new Uint8Array(64).fill(7));
		expect(parseWebhookSignatureHeader(`ed25519=${signature}, kid=ds_k ,t=12`)).toEqual({
			timestamp: 12,
			kid: 'ds_k',
			signature: new Uint8Array(64).fill(7),
		});
	});

	it('fetches the JWKS, caches it, and refetches for a rotated key', async () => {
		const first = await signingKey();
		const rotated = await signingKey();
		let served = [first.jwk];
		const fetched: string[] = [];
		let time = clock();
		const keys = jwksWebhookKeys({
			url: webhookJwksUrl('https://ds.test/v1/stream/'),
			fetch: async (url) => {
				fetched.push(url);
				return Response.json({ keys: served });
			},
			now: () => time,
			minRefreshIntervalMs: 1_000,
		});
		const verify = async (key: typeof first) =>
			(
				await verifyWebhookSignature({
					body: wakeBody,
					header: await sign(key, wakeBody, now),
					keys,
					now: clock,
				})
			).ok;

		expect(await verify(first)).toBe(true);
		expect(await verify(first)).toBe(true);
		expect(fetched).toEqual(['https://ds.test/v1/stream/__ds/jwks.json']);

		served = [first.jwk, rotated.jwk];
		// Within the refresh floor an unknown kid does not refetch.
		expect(await verify(rotated)).toBe(false);
		expect(fetched).toHaveLength(1);
		time += 1_001;
		expect(await verify(rotated)).toBe(true);
		expect(fetched).toHaveLength(2);
	});
});

describe('webhook bodies', () => {
	it('parses a wake', () => {
		expect(parseWebhookBody(wakeBody)).toEqual(JSON.parse(wakeBody));
	});

	it('rejects malformed wakes', () => {
		const wake = JSON.parse(wakeBody) as Record<string, unknown>;
		for (const bad of [
			'not json',
			'[]',
			JSON.stringify({ ...wake, generation: -1 }),
			JSON.stringify({ ...wake, generation: '7' }),
			JSON.stringify({ ...wake, streams: {} }),
			JSON.stringify({ ...wake, callback_url: '' }),
			JSON.stringify({ ...wake, streams: [{ path: 'a', link_type: 'other' }] }),
		]) {
			expect(() => parseWebhookBody(bad)).toThrow(/Invalid Durable Streams webhook/);
		}
	});

	it('receives a signed request and answers done', async () => {
		const key = await signingKey();
		const keys = staticWebhookKeys({ keys: [key.jwk] });
		const request = new Request('https://worker.test/__flue/streams/wake', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'webhook-signature': await sign(key, wakeBody, now),
			},
			body: wakeBody,
		});
		const received = await receiveWebhook(request, { keys, now: clock });
		if (!received.ok) throw new Error(`expected a verified wake, got ${received.reason}`);
		expect(received.webhook.streams[0]?.tail_offset).toBe('0000000000000000_0000000000000084');
		expect(await webhookDoneResponse().json()).toEqual({ done: true });

		const unsigned = await receiveWebhook(
			new Request('https://worker.test/', { method: 'POST', body: wakeBody }),
			{ keys, now: clock },
		);
		expect(unsigned).toEqual({ ok: false, status: 401, reason: 'missing-signature' });

		const junk = '{"subscription_id":"x"}';
		const invalid = await receiveWebhook(
			new Request('https://worker.test/', {
				method: 'POST',
				headers: { 'webhook-signature': await sign(key, junk, now) },
				body: junk,
			}),
			{ keys, now: clock },
		);
		expect(invalid).toMatchObject({ ok: false, status: 400 });
	});

	it('acks through the callback and recognizes FENCED', async () => {
		const wake = parseWebhookBody(wakeBody);
		const requests: Request[] = [];
		const tail = wake.streams[0]?.tail_offset as string;
		const ok = await acknowledgeWebhookWake(
			wake,
			{ acks: [{ stream: 'flue/v1/support/alice/inbox', offset: tail }], done: true },
			{
				fetch: async (url, init) => {
					requests.push(new Request(url, init));
					return Response.json({ ok: true, next_wake: true });
				},
			},
		);
		expect(ok).toEqual({ status: 'ok', nextWake: true });
		const sent = requests[0] as Request;
		expect(sent.url).toBe(wake.callback_url);
		expect(sent.headers.get('authorization')).toBe('Bearer eyJ.token');
		expect(await sent.json()).toEqual({
			wake_id: wake.wake_id,
			generation: 7,
			acks: [{ stream: 'flue/v1/support/alice/inbox', offset: '0000000000000000_0000000000000084' }],
			done: true,
		});

		const fenced = await acknowledgeWebhookWake(
			wake,
			{ acks: [] },
			{ fetch: async () => Response.json({ error: { code: 'FENCED' } }, { status: 409 }) },
		);
		expect(fenced).toEqual({ status: 'fenced' });
		await expect(
			acknowledgeWebhookWake(
				wake,
				{ acks: [] },
				{
					fetch: async () =>
						Response.json({ error: { code: 'TOKEN_INVALID' } }, { status: 401 }),
				},
			),
		).rejects.toThrow(/TOKEN_INVALID/);
	});
});
