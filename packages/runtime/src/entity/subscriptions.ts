/**
 * Electric webhook subscriptions for entity wakes (PI_UPGRADE_PLAN.md §2.5),
 * through the subscription API — the agents-server's proxy of it in
 * production (`PUT {publicUrl}/__ds/subscriptions/{id}`), or a bare Durable
 * Streams server's (`PUT {root}/__ds/subscriptions/{id}`, root `…/v1/stream`).
 * Pass the root you also give `ElectricDurableStreamLog` as `baseUrl`.
 *
 * Two kinds, both pointing at the Worker's
 * `https://<worker>.nymphai.workers.dev/__flue/streams/wake`:
 *
 * - `flue-inbox` — `pattern: "flue/v1/*\/*\/inbox"`: every entity inbox, the
 *   wake for A2A messages. Created once per deployment ({@link ensureInbox}).
 * - `flue-obs.<type>.<id>` — one per observing entity: its explicit observed
 *   streams. The id names the entity, so the route wakes only that observer.
 *   Its pattern is the entity's never-written `…/wake` path, because a
 *   subscription needs a pattern or a stream at creation; streams are then
 *   added with `POST …/streams` (idempotent) and removed with `DELETE`.
 *
 * `PUT` is idempotent only for an identical configuration (the server hashes
 * type, pattern, streams, webhook URL, lease and description); a different
 * one is `409 SUBSCRIPTION_ALREADY_EXISTS`. Recreating a subscription links
 * existing streams at their current tail, so wakes for data already there
 * would be lost — {@link EntitySubscriptionsError} reports the conflict
 * instead of deleting, unless `replaceOnConflict` is set.
 */
import type { EntitySubscriptionPort } from './facet.ts';
import {
	INBOX_PATTERN,
	INBOX_SUBSCRIPTION_ID,
	observeSubscriptionId,
	wakeAnchorPath,
	wirePath,
} from './paths.ts';
import type { EntityRef } from './services.ts';

export interface EntitySubscriptionsOptions {
	/** Stream root: the agents-server public URL, or `…/v1/stream` of a bare server. */
	readonly root: string;
	/** The Worker's public wake route, e.g. `https://flue.nymphai.workers.dev/__flue/streams/wake`. */
	readonly webhookUrl: string;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	/** Extra headers (e.g. the agents-server's bearer). */
	readonly headers?: () => Record<string, string> | Promise<Record<string, string>>;
	/** Lease of an unacked wake (server bounds: 1 000–600 000 ms). */
	readonly leaseTtlMs?: number;
	readonly inboxSubscriptionId?: string;
	/** Delete and recreate a subscription whose stored configuration differs. Default false. */
	readonly replaceOnConflict?: boolean;
}

export interface EnsuredSubscription {
	readonly id: string;
	readonly created: boolean;
	/** `webhook.signing.jwks_url` from the server, when it reports one (the agents-server does). */
	readonly jwksUrl?: string;
}

export class EntitySubscriptionsError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(`[flue] ${message}`);
		this.name = 'EntitySubscriptionsError';
		this.status = status;
	}
}

export interface EntitySubscriptions extends EntitySubscriptionPort {
	/** Ensure the shared `flue/v1/*\/*\/inbox` subscription. */
	ensureInbox(): Promise<EnsuredSubscription>;
	/** Ensure an entity's observe subscription exists (no streams added). */
	ensureObserver(entity: EntityRef): Promise<EnsuredSubscription>;
}

export function createEntitySubscriptions(options: EntitySubscriptionsOptions): EntitySubscriptions {
	const root = options.root.replace(/\/+$/, '');
	const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	const ensured = new Set<string>();

	const url = (id: string, suffix = '') => `${root}/__ds/subscriptions/${encodeURIComponent(id)}${suffix}`;

	async function request(target: string, init: RequestInit): Promise<Response> {
		const headers = { ...(await options.headers?.()), ...(init.headers as Record<string, string> | undefined) };
		return fetchImpl(target, { ...init, headers });
	}

	async function put(id: string, body: Record<string, unknown>): Promise<EnsuredSubscription> {
		const send = () =>
			request(url(id), {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
		let response = await send();
		if (response.status === 409 && options.replaceOnConflict) {
			await response.text();
			const deleted = await request(url(id), { method: 'DELETE' });
			await deleted.text();
			response = await send();
		}
		const text = await response.text();
		if (response.status !== 200 && response.status !== 201) {
			throw new EntitySubscriptionsError(
				`Subscription "${id}" could not be ensured: ${response.status} ${text.slice(0, 500)}`,
				response.status,
			);
		}
		let jwksUrl: string | undefined;
		try {
			const parsed = JSON.parse(text) as { webhook?: { signing?: { jwks_url?: unknown } } };
			const value = parsed.webhook?.signing?.jwks_url;
			if (typeof value === 'string') jwksUrl = value;
		} catch {
			// A body is informational only.
		}
		return { id, created: response.status === 201, ...(jwksUrl ? { jwksUrl } : {}) };
	}

	function subscriptionBody(pattern: string, description: string): Record<string, unknown> {
		return {
			type: 'webhook',
			pattern,
			webhook: { url: options.webhookUrl },
			...(options.leaseTtlMs === undefined ? {} : { lease_ttl_ms: options.leaseTtlMs }),
			description,
		};
	}

	async function ensureObserver(entity: EntityRef): Promise<EnsuredSubscription> {
		const id = observeSubscriptionId(entity);
		const result = await put(id, subscriptionBody(wirePath(wakeAnchorPath(entity)), 'flue entity observations'));
		ensured.add(id);
		return result;
	}

	return {
		ensureInbox: () =>
			put(options.inboxSubscriptionId ?? INBOX_SUBSCRIPTION_ID, subscriptionBody(INBOX_PATTERN, 'flue entity inboxes')),
		ensureObserver,
		async observe(entity, streams) {
			if (streams.length === 0) return;
			const id = observeSubscriptionId(entity);
			if (!ensured.has(id)) await ensureObserver(entity);
			const response = await request(url(id, '/streams'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ streams: streams.map((stream) => wirePath(stream)) }),
			});
			const text = await response.text();
			if (!response.ok) {
				throw new EntitySubscriptionsError(
					`Adding streams to "${id}" failed: ${response.status} ${text.slice(0, 500)}`,
					response.status,
				);
			}
		},
		async unobserve(entity, stream) {
			const id = observeSubscriptionId(entity);
			const response = await request(url(id, `/streams/${encodeURIComponent(wirePath(stream))}`), {
				method: 'DELETE',
			});
			const text = await response.text();
			if (!response.ok && response.status !== 404) {
				throw new EntitySubscriptionsError(
					`Removing "${stream}" from "${id}" failed: ${response.status} ${text.slice(0, 500)}`,
					response.status,
				);
			}
		},
	};
}
