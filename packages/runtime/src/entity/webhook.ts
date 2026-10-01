/**
 * Durable Streams webhook subscriptions, receiver side (PROTOCOL.md §6.5,
 * §7.1): verify a wake's `Webhook-Signature`, parse its body, and acknowledge
 * it through the callback. WebCrypto and `fetch` only, so it runs on workerd.
 *
 * Wire format, as the reference Node server (`@durable-streams/server`,
 * `src/crypto.ts` + `src/subscription-manager.ts`) produces it:
 *
 * - header `webhook-signature: t=<unix seconds>,kid=<key id>,ed25519=<sig>`,
 *   where `<sig>` is the unpadded base64url Ed25519 signature over the bytes
 *   of `` `${t}.${rawBody}` ``;
 * - keys are an RFC 7517 JWK Set of `OKP`/`Ed25519` keys, served at
 *   `{stream-root}/__ds/jwks.json` (the Node server's root is `/v1/stream`);
 *   `kid` is `ds_` + base64url(SHA-256 of the RFC 7638 thumbprint input);
 * - body `{ subscription_id, wake_id, generation, streams: [{ path,
 *   link_type, acked_offset, tail_offset, has_pending }], callback_url,
 *   callback_token }`;
 * - a `200 { "done": true }` reply acks every `tail_offset` of the wake;
 *   anything else leaves the wake to the callback (or the lease timeout).
 *
 * ## Behind Electric's agents-server (the production path)
 *
 * agents-server 0.6.4 fronts its durable-streams server and proxies the
 * subscription API (`routing/durable-streams-router.ts`,
 * `routing/internal-router.ts`). What reaches the Worker differs:
 *
 * - `PUT {publicUrl}/__ds/subscriptions/{id}` stores the caller's
 *   `webhook.url` and registers its own
 *   `{publicUrl}/_electric/subscription-webhooks/{id}` with the backend; the
 *   response's `webhook.signing.jwks_url` names its JWKS.
 * - The backend's wake is verified there, then **re-signed** with the
 *   agents-server's own Ed25519 key (`ELECTRIC_AGENTS_WEBHOOK_SIGNING_PRIVATE_KEY`,
 *   random per process when unset) in the same header format
 *   (`webhook-signature: t=…,kid=…,ed25519=…` over `${t}.${body}`), with the
 *   JWKS at `{publicUrl}/__ds/jwks.json`.
 * - The body is rewritten: the backend fields stay (`subscription_id`,
 *   `wake_id`, `generation`, `callback_url`, `callback_token`), but
 *   `streams` becomes **only the first pending stream** as
 *   `[{ path: "/<path>", offset: <tail_offset> }]`, and it adds
 *   `wakeId`, `consumerId`, `epoch` (= generation), `streamPath`,
 *   `claimToken` (= callback_token) and `callback`
 *   (`{publicUrl}/_electric/wake-callbacks/{wakeId}`) — plus `entity`,
 *   `principal`, `triggerEvent` for streams of registered Electric entities.
 * - The Worker's reply is relayed to the backend verbatim, so `{done:true}`
 *   would ack streams the Worker never saw. Ack through `callback` instead,
 *   with `Authorization: Bearer <claimToken>` and
 *   `{ generation, acks: [{ stream, offset }], done }`; the agents-server
 *   treats a body carrying a wake id **without** `done: true` as a claim and
 *   does not forward it, so acks never send one.
 *
 * {@link parseWakeNotice} accepts both and normalizes them to a
 * {@link WakeNotice}; the agents-server form is tried first.
 */

import { decodeBase64 } from '../base64.ts';
import { asStreamOffset, type StreamOffset } from '../streams/offset.ts';

/** The public half of a webhook signing key (PROTOCOL §6.5). */
export interface WebhookJwk {
	readonly kty: 'OKP';
	readonly crv: 'Ed25519';
	readonly x: string;
	readonly kid: string;
	readonly use?: string;
	readonly alg?: string;
}

export interface WebhookJwks {
	readonly keys: readonly WebhookJwk[];
}

export interface WebhookSignature {
	/** Unix seconds from the `t` parameter. */
	readonly timestamp: number;
	/** `t` exactly as sent: the signed bytes are `` `${t}.${body}` `` over this text. */
	readonly timestampText: string;
	readonly kid: string;
	readonly signature: Uint8Array<ArrayBuffer>;
}

/** Resolves a `kid` to its verification key, or `null` when unknown. */
export type WebhookKeyResolver = (kid: string) => Promise<CryptoKey | null>;

export type WebhookVerification =
	| { readonly ok: true; readonly timestamp: number; readonly kid: string }
	| {
			readonly ok: false;
			readonly reason: 'missing-signature' | 'malformed-signature' | 'stale-timestamp' | 'unknown-key' | 'bad-signature';
	  };

export interface DurableStreamsWebhookStream {
	/** Stream-root-relative path. */
	readonly path: string;
	readonly link_type: 'glob' | 'explicit';
	/** Last processed offset, inclusive. */
	readonly acked_offset: StreamOffset;
	/** The stream's tail when the wake was issued: acking it drains the snapshot. */
	readonly tail_offset: StreamOffset;
	readonly has_pending: boolean;
}

/** A webhook wake (PROTOCOL §7.1). */
export interface DurableStreamsWebhook {
	readonly subscription_id: string;
	readonly wake_id: string;
	/** Subscription-scoped fencing counter; stale callbacks are 409 `FENCED`. */
	readonly generation: number;
	readonly streams: readonly DurableStreamsWebhookStream[];
	readonly callback_url: string;
	readonly callback_token: string;
}

/** Default replay window (PROTOCOL §7.1: "such as five minutes"). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Ed25519 signatures are 64 bytes. */
const SIGNATURE_BYTES = 64;

const encoder = new TextEncoder();

export class WebhookPayloadError extends Error {
	constructor(message: string) {
		super(`[flue] Invalid Durable Streams webhook: ${message}`);
		this.name = 'WebhookPayloadError';
	}
}

/** `{baseUrl}/__ds/jwks.json` for a stream root such as `https://host/v1/stream`. */
export function webhookJwksUrl(streamRoot: string): string {
	return `${streamRoot.replace(/\/+$/, '')}/__ds/jwks.json`;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	try {
		return new Uint8Array(decodeBase64(padded));
	} catch {
		return null;
	}
}

/**
 * Parse `t=<ts>,kid=<kid>,ed25519=<sig>`. Parameters may come in any order;
 * each must appear exactly once.
 */
export function parseWebhookSignatureHeader(header: string): WebhookSignature | null {
	const fields = new Map<string, string>();
	for (const part of header.split(',')) {
		const index = part.indexOf('=');
		if (index <= 0) return null;
		const name = part.slice(0, index).trim();
		if (fields.has(name)) return null;
		fields.set(name, part.slice(index + 1).trim());
	}
	const t = fields.get('t');
	const kid = fields.get('kid');
	const encoded = fields.get('ed25519');
	if (t === undefined || kid === undefined || encoded === undefined) return null;
	if (!/^\d+$/.test(t) || kid.length === 0) return null;
	const timestamp = Number(t);
	if (!Number.isSafeInteger(timestamp)) return null;
	const signature = decodeBase64Url(encoded);
	if (!signature || signature.length !== SIGNATURE_BYTES) return null;
	return { timestamp, timestampText: t, kid, signature };
}

function isWebhookJwk(value: unknown): value is WebhookJwk {
	if (typeof value !== 'object' || value === null) return false;
	const key = value as Record<string, unknown>;
	return (
		key.kty === 'OKP' &&
		key.crv === 'Ed25519' &&
		typeof key.x === 'string' &&
		typeof key.kid === 'string' &&
		key.kid.length > 0
	);
}

/** Import one JWK as an Ed25519 verification key. */
export function importWebhookKey(jwk: WebhookJwk): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'jwk',
		{ kty: 'OKP', crv: 'Ed25519', x: jwk.x },
		{ name: 'Ed25519' },
		false,
		['verify'],
	);
}

/** Keys from an in-hand JWK Set (tests, or a set pinned in configuration). */
export function staticWebhookKeys(jwks: WebhookJwks): WebhookKeyResolver {
	const keys = new Map<string, Promise<CryptoKey>>();
	for (const jwk of jwks.keys) {
		if (isWebhookJwk(jwk)) keys.set(jwk.kid, importWebhookKey(jwk));
	}
	return async (kid) => (await keys.get(kid)) ?? null;
}

export interface JwksWebhookKeysOptions {
	/** Usually `webhookJwksUrl(streamRoot)`, or `webhook.signing.jwks_url` from the subscription. */
	readonly url: string;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	/** How long a fetched set is trusted (default 5 min, the server's `max-age`). */
	readonly cacheTtlMs?: number;
	/** Floor between refetches triggered by an unknown `kid` (default 10s). */
	readonly minRefreshIntervalMs?: number;
	readonly now?: () => number;
}

/**
 * Keys fetched from the server's JWKS and cached. An unknown `kid` triggers a
 * refetch (key rotation), rate-limited so forged `kid`s cannot turn every
 * request into an outbound fetch.
 */
export function jwksWebhookKeys(options: JwksWebhookKeysOptions): WebhookKeyResolver {
	const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	const ttl = options.cacheTtlMs ?? 300_000;
	const minRefresh = options.minRefreshIntervalMs ?? 10_000;
	const now = options.now ?? Date.now;
	let keys = new Map<string, Promise<CryptoKey>>();
	let fetchedAt = Number.NEGATIVE_INFINITY;
	let inFlight: Promise<void> | undefined;

	const refresh = (): Promise<void> => {
		inFlight ??= (async () => {
			try {
				const response = await fetchImpl(options.url, {
					headers: { accept: 'application/jwk-set+json, application/json' },
				});
				if (!response.ok) {
					throw new Error(`JWKS fetch from ${options.url} failed with ${response.status}.`);
				}
				const body = (await response.json()) as { keys?: unknown };
				const next = new Map<string, Promise<CryptoKey>>();
				for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
					if (isWebhookJwk(jwk)) next.set(jwk.kid, importWebhookKey(jwk));
				}
				keys = next;
				fetchedAt = now();
			} finally {
				inFlight = undefined;
			}
		})();
		return inFlight;
	};

	return async (kid) => {
		const age = now() - fetchedAt;
		if (age > ttl || (!keys.has(kid) && age > minRefresh)) await refresh();
		const key = keys.get(kid);
		return key ? await key : null;
	};
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(head.length + tail.length);
	bytes.set(head, 0);
	bytes.set(tail, head.length);
	return bytes;
}

/**
 * Verify a wake's `Webhook-Signature` against the raw body. Pass the body
 * exactly as received — re-serialized JSON will not verify.
 */
export async function verifyWebhookSignature(options: {
	readonly body: string | Uint8Array;
	readonly header: string | null | undefined;
	readonly keys: WebhookKeyResolver;
	/** Current time in ms (default `Date.now`). */
	readonly now?: () => number;
	readonly toleranceSeconds?: number;
}): Promise<WebhookVerification> {
	if (!options.header) return { ok: false, reason: 'missing-signature' };
	const parsed = parseWebhookSignatureHeader(options.header);
	if (!parsed) return { ok: false, reason: 'malformed-signature' };
	const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
	const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
	if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
		return { ok: false, reason: 'stale-timestamp' };
	}
	const key = await options.keys(parsed.kid);
	if (!key) return { ok: false, reason: 'unknown-key' };
	const body = typeof options.body === 'string' ? encoder.encode(options.body) : options.body;
	const signed = concatBytes(encoder.encode(`${parsed.timestampText}.`), body);
	const valid = await crypto.subtle.verify('Ed25519', key, parsed.signature, signed);
	return valid
		? { ok: true, timestamp: parsed.timestamp, kid: parsed.kid }
		: { ok: false, reason: 'bad-signature' };
}

function requireString(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== 'string' || value.length === 0) {
		throw new WebhookPayloadError(`"${field}" must be a non-empty string.`);
	}
	return value;
}

/** Parse and validate a wake body (PROTOCOL §7.1). */
export function parseWebhookBody(text: string): DurableStreamsWebhook {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new WebhookPayloadError('the body is not JSON.');
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new WebhookPayloadError('the body is not a JSON object.');
	}
	const record = value as Record<string, unknown>;
	const generation = record.generation;
	if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
		throw new WebhookPayloadError('"generation" must be a non-negative integer.');
	}
	if (!Array.isArray(record.streams)) {
		throw new WebhookPayloadError('"streams" must be an array.');
	}
	const streams = record.streams.map((entry, index): DurableStreamsWebhookStream => {
		if (typeof entry !== 'object' || entry === null) {
			throw new WebhookPayloadError(`streams[${index}] is not an object.`);
		}
		const stream = entry as Record<string, unknown>;
		const linkType = stream.link_type;
		if (linkType !== 'glob' && linkType !== 'explicit') {
			throw new WebhookPayloadError(`streams[${index}].link_type must be "glob" or "explicit".`);
		}
		if (typeof stream.has_pending !== 'boolean') {
			throw new WebhookPayloadError(`streams[${index}].has_pending must be a boolean.`);
		}
		return {
			path: requireString(stream, 'path'),
			link_type: linkType,
			acked_offset: asStreamOffset(requireString(stream, 'acked_offset')),
			tail_offset: asStreamOffset(requireString(stream, 'tail_offset')),
			has_pending: stream.has_pending,
		};
	});
	return {
		subscription_id: requireString(record, 'subscription_id'),
		wake_id: requireString(record, 'wake_id'),
		generation,
		streams,
		callback_url: requireString(record, 'callback_url'),
		callback_token: requireString(record, 'callback_token'),
	};
}

export type ReceivedWebhook =
	| { readonly ok: true; readonly webhook: DurableStreamsWebhook }
	| {
			readonly ok: false;
			/** 401 for a signature failure, 400 for a verified but malformed body. */
			readonly status: 400 | 401;
			readonly reason: string;
	  };

/** Verify and parse an incoming webhook request. Consumes the request body. */
export async function receiveWebhook(
	request: Request,
	options: {
		readonly keys: WebhookKeyResolver;
		readonly now?: () => number;
		readonly toleranceSeconds?: number;
	},
): Promise<ReceivedWebhook> {
	const body = new Uint8Array(await request.arrayBuffer());
	const verification = await verifyWebhookSignature({
		body,
		header: request.headers.get('webhook-signature'),
		keys: options.keys,
		...(options.now ? { now: options.now } : {}),
		...(options.toleranceSeconds === undefined ? {} : { toleranceSeconds: options.toleranceSeconds }),
	});
	if (!verification.ok) return { ok: false, status: 401, reason: verification.reason };
	try {
		return { ok: true, webhook: parseWebhookBody(new TextDecoder().decode(body)) };
	} catch (error) {
		return {
			ok: false,
			status: 400,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/** The synchronous reply that acks every `tail_offset` of the wake (PROTOCOL §7.1). */
export function webhookDoneResponse(): Response {
	return Response.json({ done: true });
}

export type WakeAckResult =
	| { readonly status: 'ok'; readonly nextWake: boolean }
	/** 409 `FENCED`: the wake is stale (a newer generation or wake id). */
	| { readonly status: 'fenced' };

/**
 * Ack a wake through its callback (PROTOCOL §7.1): `acks` are last-processed
 * offsets, inclusive; `done: true` releases the lease.
 */
export async function acknowledgeWebhookWake(
	webhook: DurableStreamsWebhook,
	input: {
		readonly acks: readonly { readonly stream: string; readonly offset: string }[];
		readonly done?: boolean;
	},
	options: {
		readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
		readonly signal?: AbortSignal;
	} = {},
): Promise<WakeAckResult> {
	const fetchImpl = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
	const response = await fetchImpl(webhook.callback_url, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${webhook.callback_token}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			wake_id: webhook.wake_id,
			generation: webhook.generation,
			acks: input.acks,
			...(input.done === undefined ? {} : { done: input.done }),
		}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = undefined;
	}
	const code = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
	if (response.status === 409 && code === 'FENCED') return { status: 'fenced' };
	if (!response.ok) {
		throw new Error(
			`[flue] Durable Streams wake callback failed with ${response.status}${typeof code === 'string' ? ` (${code})` : ''}.`,
		);
	}
	return {
		status: 'ok',
		nextWake: (body as { next_wake?: unknown } | undefined)?.next_wake === true,
	};
}

// ─── Normalized wakes (agents-server first, bare Durable Streams second) ────

export type WakeFormat = 'agents-server' | 'durable-streams';

export interface WakeNoticeStream {
	/** Wire path (as the server names the stream), without a leading slash. */
	readonly path: string;
	/** The stream's tail when the wake was issued. */
	readonly tailOffset: StreamOffset;
	/** Whether the stream had unacked data; agents-server wakes list only a pending stream. */
	readonly pending: boolean;
}

/** One wake, whichever server signed it. */
export interface WakeNotice {
	readonly format: WakeFormat;
	readonly subscriptionId: string;
	readonly wakeId: string;
	readonly generation: number;
	readonly streams: readonly WakeNoticeStream[];
	/** Where acks go, and the bearer token they carry. */
	readonly callback: { readonly url: string; readonly token: string };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripLeadingSlash(path: string): string {
	return path.replace(/^\/+/, '');
}

function parseGeneration(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new WebhookPayloadError(`"${field}" must be a non-negative integer.`);
	}
	return value;
}

/** The agents-server form (`routing/internal-router.ts` `subscriptionWebhook`). */
function agentsServerNotice(record: Record<string, unknown>): WakeNotice | undefined {
	if (
		typeof record.wakeId !== 'string' ||
		typeof record.callback !== 'string' ||
		typeof record.claimToken !== 'string' ||
		!Array.isArray(record.streams)
	) {
		return undefined;
	}
	const streams = record.streams.map((entry, index): WakeNoticeStream => {
		if (!isRecordValue(entry)) throw new WebhookPayloadError(`streams[${index}] is not an object.`);
		return {
			path: stripLeadingSlash(requireString(entry, 'path')),
			tailOffset: asStreamOffset(requireString(entry, 'offset')),
			pending: true,
		};
	});
	return {
		format: 'agents-server',
		subscriptionId: requireString(record, 'subscription_id'),
		wakeId: requireString(record, 'wakeId'),
		generation: parseGeneration(record.epoch ?? record.generation, 'epoch'),
		streams,
		callback: { url: requireString(record, 'callback'), token: requireString(record, 'claimToken') },
	};
}

/** Parse a wake body from the agents-server or a bare Durable Streams server. */
export function parseWakeNotice(text: string): WakeNotice {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new WebhookPayloadError('the body is not JSON.');
	}
	if (!isRecordValue(value)) throw new WebhookPayloadError('the body is not a JSON object.');
	const proxied = agentsServerNotice(value);
	if (proxied) return proxied;
	const webhook = parseWebhookBody(text);
	return {
		format: 'durable-streams',
		subscriptionId: webhook.subscription_id,
		wakeId: webhook.wake_id,
		generation: webhook.generation,
		streams: webhook.streams.map((stream) => ({
			path: stripLeadingSlash(stream.path),
			tailOffset: stream.tail_offset,
			pending: stream.has_pending,
		})),
		callback: { url: webhook.callback_url, token: webhook.callback_token },
	};
}

export type ReceivedWakeNotice =
	| { readonly ok: true; readonly notice: WakeNotice }
	| { readonly ok: false; readonly status: 400 | 401; readonly reason: string };

/** Verify and parse an incoming wake of either format. Consumes the request body. */
export async function receiveWakeNotice(
	request: Request,
	options: {
		readonly keys: WebhookKeyResolver;
		readonly now?: () => number;
		readonly toleranceSeconds?: number;
	},
): Promise<ReceivedWakeNotice> {
	const body = new Uint8Array(await request.arrayBuffer());
	const verification = await verifyWebhookSignature({
		body,
		header: request.headers.get('webhook-signature'),
		keys: options.keys,
		...(options.now ? { now: options.now } : {}),
		...(options.toleranceSeconds === undefined ? {} : { toleranceSeconds: options.toleranceSeconds }),
	});
	if (!verification.ok) return { ok: false, status: 401, reason: verification.reason };
	try {
		return { ok: true, notice: parseWakeNotice(new TextDecoder().decode(body)) };
	} catch (error) {
		return { ok: false, status: 400, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Ack a wake through its callback, in the format its server expects. `acks`
 * are last-processed offsets (inclusive) by wire path; `done: true` releases
 * the wake and lets the server issue the next one for what is still pending.
 */
export async function acknowledgeWakeNotice(
	notice: WakeNotice,
	input: {
		readonly acks: readonly { readonly stream: string; readonly offset: string }[];
		readonly done?: boolean;
	},
	options: {
		readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
		readonly signal?: AbortSignal;
	} = {},
): Promise<WakeAckResult> {
	if (notice.format === 'durable-streams') {
		return acknowledgeWebhookWake(
			{
				subscription_id: notice.subscriptionId,
				wake_id: notice.wakeId,
				generation: notice.generation,
				streams: [],
				callback_url: notice.callback.url,
				callback_token: notice.callback.token,
			},
			input,
			options,
		);
	}
	const fetchImpl = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
	const response = await fetchImpl(notice.callback.url, {
		method: 'POST',
		headers: { authorization: `Bearer ${notice.callback.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			generation: notice.generation,
			acks: input.acks.map((ack) => ({ stream: stripLeadingSlash(ack.stream), offset: ack.offset })),
			// A wake id without `done: true` is a claim to the agents-server, which it does not forward.
			...(input.done === true ? { done: true, wake_id: notice.wakeId } : {}),
		}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = undefined;
	}
	const code = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
	if (response.status === 409 && code === 'FENCED') return { status: 'fenced' };
	if (!response.ok) {
		throw new Error(
			`[flue] agents-server wake callback failed with ${response.status}${typeof code === 'string' ? ` (${code})` : ''}.`,
		);
	}
	return { status: 'ok', nextWake: (body as { next_wake?: unknown } | undefined)?.next_wake === true };
}
