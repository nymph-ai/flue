/**
 * Where entity streams live (docs/cloudflare-native.md rule 2): Electric
 * carries entity events only — each instance's inbox
 * (`flue/v1/{type}/{id}/inbox`), what it publishes (`…/events`), and the
 * world streams it observes. Pi's commits stay in the instance's own SQLite.
 *
 * An app opts into an Electric server (the agents-server, or a bare Durable
 * Streams server) either in code — the same way it registers providers in
 * `app.ts`:
 *
 * ```ts
 * import { env } from 'cloudflare:workers';
 * import { electricStreams, setStreams } from '@flue/runtime';
 *
 * setStreams(
 *   electricStreams({
 *     baseUrl: env.FLUE_STREAMS_URL,
 *     fetch: (input, init) => env.ELECTRIC.fetch(input, init),
 *   }),
 * );
 * ```
 *
 * or with no code at all, from the deployment's environment (wrangler
 * `vars` and bindings, or the process environment on Node):
 *
 * - `FLUE_STREAMS_URL` — the stream root. Behind the agents-server that is
 *   its own root (it serves the Durable Streams protocol at `/` and forwards
 *   to its backend's `/v1/stream` itself); a bare Durable Streams server's
 *   root is `…/v1/stream`.
 * - `FLUE_STREAMS` (optional) — a service binding (e.g. a VPC service) whose
 *   `fetch` reaches the server; without one the global `fetch` is used.
 * - `FLUE_STREAMS_TOKEN` (optional) — sent as `Authorization: Bearer …`.
 * - `FLUE_STREAMS_JWKS_URL` (optional) — where wake webhooks' signing keys
 *   are published; default `${FLUE_STREAMS_URL}/__ds/jwks.json`.
 * - `FLUE_STREAMS_WEBHOOK_URL` (optional) — this Worker's public wake route
 *   (`https://<worker>/__flue/streams/wake`), registered as the webhook of
 *   the entity inbox subscription; default: derived from the first request
 *   the Worker serves.
 *
 * With Electric configured, agent instances are addressable entities
 * (`entity/*`): they message, publish to, observe, spawn and schedule each
 * other, and the Worker serves the wake route that rings their doorbells.
 */
import { createEntitySubscriptions, type EntitySubscriptions } from '../entity/subscriptions.ts';
import { jwksWebhookKeys, type WebhookKeyResolver, webhookJwksUrl } from '../entity/webhook.ts';
import { ElectricDurableStreamLog } from '../streams/electric-log.ts';
import type { DurableStreamLog } from '../streams/log.ts';

type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
type HeaderRecord = Record<string, string>;

/** An Electric (Durable Streams HTTP) server holding every instance's entity streams. */
export interface ElectricStreamsConfig {
	readonly kind: 'electric';
	/** The stream root; an instance's inbox is `${baseUrl}/flue/v1/{agent}/{id}/inbox`. */
	readonly baseUrl: string;
	/** How requests reach the server: a service binding's `fetch`, or the global one. */
	readonly fetch?: FetchLike;
	/** Extra headers on every request (auth); a function is evaluated per request. */
	readonly headers?: HeaderRecord | (() => HeaderRecord | Promise<HeaderRecord>);
	/** Entity wakes: how webhooks are verified, and where they are delivered. */
	readonly webhook?: {
		/** Signing keys; default `${baseUrl}/__ds/jwks.json`. */
		readonly jwksUrl?: string;
		/** This Worker's public wake route; default derived from its first request. */
		readonly url?: string;
	};
}

export type FlueStreamsConfig = ElectricStreamsConfig;

/** Describe an Electric (Durable Streams) server for {@link setStreams}. */
export function electricStreams(
	options: Omit<ElectricStreamsConfig, 'kind'>,
): ElectricStreamsConfig {
	if (typeof options?.baseUrl !== 'string' || options.baseUrl.trim() === '') {
		throw new Error('[flue] electricStreams() requires a non-empty `baseUrl`.');
	}
	return { kind: 'electric', ...options };
}

let configured: FlueStreamsConfig | undefined;

/**
 * Keep entity streams on `config`, which makes agent instances addressable
 * entities. Call it at module scope (e.g. in `app.ts`), before the first
 * request; `undefined` restores the default.
 */
export function setStreams(config: FlueStreamsConfig | undefined): void {
	if (config !== undefined && config.kind !== 'electric') {
		throw new Error(
			'[flue] setStreams() takes a streams configuration, e.g. electricStreams({ baseUrl }).',
		);
	}
	configured = config;
}

function fromEnv(env: Record<string, unknown> | undefined): FlueStreamsConfig | undefined {
	const baseUrl = env?.FLUE_STREAMS_URL;
	if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return undefined;
	const binding = env?.FLUE_STREAMS as { fetch?: FetchLike } | undefined;
	const token = env?.FLUE_STREAMS_TOKEN;
	const jwksUrl = env?.FLUE_STREAMS_JWKS_URL;
	const webhookUrl = env?.FLUE_STREAMS_WEBHOOK_URL;
	return {
		kind: 'electric',
		baseUrl,
		...(binding && typeof binding.fetch === 'function'
			? {
					fetch: (input: Request | string | URL, init?: RequestInit) =>
						(binding.fetch as FetchLike).call(binding, input, init),
				}
			: {}),
		...(typeof token === 'string' && token !== ''
			? { headers: { authorization: `Bearer ${token}` } }
			: {}),
		webhook: {
			...(typeof jwksUrl === 'string' && jwksUrl !== '' ? { jwksUrl } : {}),
			...(typeof webhookUrl === 'string' && webhookUrl !== '' ? { url: webhookUrl } : {}),
		},
	};
}

/** The configured Electric streams — by {@link setStreams}, else by the environment — if any. */
export function configuredStreams(
	env: Record<string, unknown> | undefined,
): FlueStreamsConfig | undefined {
	return configured ?? fromEnv(env);
}

const logs = new WeakMap<object, DurableStreamLog>();

/** The Electric entity streams configured for this runtime, if any. */
export function configuredStreamsLog(
	env: Record<string, unknown> | undefined,
): DurableStreamLog | undefined {
	const config = configuredStreams(env);
	if (!config) return undefined;
	const key = configured ?? (env as object);
	const cached = logs.get(key);
	if (cached) return cached;
	const log = new ElectricDurableStreamLog({
		baseUrl: config.baseUrl,
		...(config.fetch ? { fetch: config.fetch } : {}),
		...(config.headers ? { headers: config.headers } : {}),
	});
	logs.set(key, log);
	return log;
}

function fetchOf(
	config: FlueStreamsConfig,
): (input: string, init?: RequestInit) => Promise<Response> {
	const fetchImpl = config.fetch;
	if (fetchImpl) return (input, init) => fetchImpl(input, init);
	return (input, init) => fetch(input, init);
}

function headersOf(config: FlueStreamsConfig): () => Promise<HeaderRecord> {
	return async () => {
		const headers = config.headers;
		return typeof headers === 'function' ? await headers() : (headers ?? {});
	};
}

/** The keys that verify entity wake webhooks. */
export function streamsWebhookKeys(config: FlueStreamsConfig): WebhookKeyResolver {
	return jwksWebhookKeys({
		url: config.webhook?.jwksUrl ?? webhookJwksUrl(config.baseUrl),
		fetch: fetchOf(config),
	});
}

/** Electric subscription management delivering entity wakes to `webhookUrl`. */
export function streamsSubscriptions(
	config: FlueStreamsConfig,
	webhookUrl: string,
): EntitySubscriptions {
	return createEntitySubscriptions({
		root: config.baseUrl,
		webhookUrl,
		fetch: fetchOf(config),
		headers: headersOf(config),
	});
}
