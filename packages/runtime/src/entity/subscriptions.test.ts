import { describe, expect, it } from 'vitest';
import {
	entityOfInboxPath,
	entityOfObserveSubscription,
	logPathFromWire,
	observeSubscriptionId,
	wirePath,
} from './paths.ts';
import { createEntitySubscriptions, EntitySubscriptionsError } from './subscriptions.ts';

/**
 * The subscription API as the agents-server proxies it: `PUT` is idempotent
 * for an identical configuration and 409s otherwise; responses carry
 * `webhook.signing.jwks_url`.
 */
function fakeSubscriptionApi() {
	const subscriptions = new Map<string, { config: string; streams: Set<string> }>();
	const requests: { method: string; url: string; body?: unknown; authorization?: string | null }[] = [];
	const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const text = await request.text();
		const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
		requests.push({
			method: request.method,
			url: request.url,
			...(body === undefined ? {} : { body }),
			authorization: request.headers.get('authorization'),
		});
		const url = new URL(request.url);
		const match = /^\/__ds\/subscriptions\/([^/]+)(\/streams(?:\/(.+))?)?$/.exec(url.pathname);
		if (!match) return new Response(null, { status: 404 });
		const id = decodeURIComponent(match[1] as string);
		const existing = subscriptions.get(id);
		if (request.method === 'PUT') {
			const config = JSON.stringify(body);
			if (existing && existing.config !== config) {
				return Response.json({ error: { code: 'SUBSCRIPTION_ALREADY_EXISTS' } }, { status: 409 });
			}
			if (!existing) subscriptions.set(id, { config, streams: new Set() });
			return Response.json(
				{
					id,
					webhook: {
						url: `https://agents.test/_electric/subscription-webhooks/${id}`,
						signing: { alg: 'ed25519', kid: 'ds_k', jwks_url: 'https://agents.test/__ds/jwks.json' },
					},
				},
				{ status: existing ? 200 : 201 },
			);
		}
		if (request.method === 'DELETE' && !match[2]) {
			subscriptions.delete(id);
			return new Response(null, { status: 204 });
		}
		if (!existing) return Response.json({ error: { code: 'SUBSCRIPTION_NOT_FOUND' } }, { status: 404 });
		if (request.method === 'POST' && match[2] === '/streams') {
			for (const stream of (body?.streams as string[]) ?? []) existing.streams.add(stream);
			return new Response(null, { status: 204 });
		}
		if (request.method === 'DELETE' && match[3]) {
			existing.streams.delete(decodeURIComponent(match[3]));
			return new Response(null, { status: 204 });
		}
		return new Response(null, { status: 405 });
	};
	return { fetch, requests, subscriptions };
}

describe('entity stream paths', () => {
	it('round-trips log paths through their wire form', () => {
		const log = 'flue/v1/worker/alice%2Fw1/inbox';
		expect(wirePath(log)).toBe('flue/v1/worker/alice%252Fw1/inbox');
		expect(logPathFromWire(`/${wirePath(log)}`)).toBe(log);
		expect(entityOfInboxPath(log)).toEqual({ type: 'worker', id: 'alice/w1' });
		expect(entityOfInboxPath('flue/v1/worker/alice/events')).toBeUndefined();
		expect(entityOfInboxPath('world/hn/items')).toBeUndefined();
	});

	it('names an observer in its subscription id', () => {
		const entity = { type: 'support agent', id: 'tenant/42·é' };
		const id = observeSubscriptionId(entity);
		expect(id).toMatch(/^flue-obs\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(entityOfObserveSubscription(id)).toEqual(entity);
		expect(entityOfObserveSubscription('flue-inbox')).toBeUndefined();
		expect(entityOfObserveSubscription('flue-obs.!!.x')).toBeUndefined();
	});
});

describe('createEntitySubscriptions', () => {
	const webhookUrl = 'https://flue.nymphai.workers.dev/__flue/streams/wake';

	it('ensures the inbox subscription idempotently and reports the JWKS', async () => {
		const api = fakeSubscriptionApi();
		const subscriptions = createEntitySubscriptions({
			root: 'https://agents.test/',
			webhookUrl,
			fetch: api.fetch,
			headers: () => ({ authorization: 'Bearer agents-secret' }),
		});
		expect(await subscriptions.ensureInbox()).toEqual({
			id: 'flue-inbox',
			created: true,
			jwksUrl: 'https://agents.test/__ds/jwks.json',
		});
		expect(await subscriptions.ensureInbox()).toMatchObject({ id: 'flue-inbox', created: false });
		expect(api.requests[0]).toEqual({
			method: 'PUT',
			url: 'https://agents.test/__ds/subscriptions/flue-inbox',
			body: {
				type: 'webhook',
				pattern: 'flue/v1/*/*/inbox',
				webhook: { url: webhookUrl },
				description: 'flue entity inboxes',
			},
			authorization: 'Bearer agents-secret',
		});
	});

	it('refuses a conflicting configuration unless asked to replace it', async () => {
		const api = fakeSubscriptionApi();
		await createEntitySubscriptions({ root: 'https://agents.test', webhookUrl, fetch: api.fetch }).ensureInbox();
		const moved = createEntitySubscriptions({
			root: 'https://agents.test',
			webhookUrl: 'https://other.workers.dev/__flue/streams/wake',
			fetch: api.fetch,
		});
		await expect(moved.ensureInbox()).rejects.toBeInstanceOf(EntitySubscriptionsError);
		const replacing = createEntitySubscriptions({
			root: 'https://agents.test',
			webhookUrl: 'https://other.workers.dev/__flue/streams/wake',
			fetch: api.fetch,
			replaceOnConflict: true,
		});
		expect(await replacing.ensureInbox()).toMatchObject({ created: true });
	});

	it('adds and removes observed streams on the observer subscription', async () => {
		const api = fakeSubscriptionApi();
		const subscriptions = createEntitySubscriptions({ root: 'https://agents.test', webhookUrl, fetch: api.fetch });
		const alice = { type: 'agent', id: 'alice' };
		await subscriptions.observe(alice, ['world/hn/items', 'flue/v1/agent/bob/events']);
		await subscriptions.observe(alice, ['world/hn/items']);
		const id = observeSubscriptionId(alice);
		expect(api.subscriptions.get(id)?.streams).toEqual(new Set(['world/hn/items', 'flue/v1/agent/bob/events']));
		expect(JSON.parse(api.subscriptions.get(id)?.config ?? '{}')).toMatchObject({
			type: 'webhook',
			pattern: 'flue/v1/agent/alice/wake',
			webhook: { url: webhookUrl },
		});
		// One PUT, however many observes.
		expect(api.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
		await subscriptions.unobserve(alice, 'world/hn/items');
		expect(api.subscriptions.get(id)?.streams).toEqual(new Set(['flue/v1/agent/bob/events']));
	});
});
