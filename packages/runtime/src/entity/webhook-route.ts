/**
 * `POST /__flue/streams/wake` — the Worker route Electric's webhook
 * subscriptions call (PI_UPGRADE_PLAN.md §2.5 "Wake").
 *
 * 1. Verify the Ed25519 `webhook-signature` against the JWKS and parse the
 *    wake, from the agents-server (primary) or a bare Durable Streams server
 *    (`webhook.ts`). 401 / 400 otherwise.
 * 2. Map streams to entities: on an observe subscription
 *    (`flue-obs.<type>.<id>`, `paths.ts`) every pending stream belongs to the
 *    entity its (signed) id names; otherwise each pending
 *    `flue/v1/{type}/{id}/inbox` belongs to that entity.
 * 3. Call `wake(entity, request)` per entity — on Cloudflare, the
 *    `__flueWake` RPC of `idFromName(entity)` (`wake-handler.ts`).
 * 4. Ack: a bare Durable Streams wake that every entity handled through its
 *    tail is answered `{ done: true }`. Otherwise — and always behind the
 *    agents-server, whose wake shows one stream but whose `{done:true}` would
 *    ack them all — the processed offsets are acked through the callback with
 *    `done: true`, so the server re-wakes for whatever is still pending, and
 *    the reply is `{ ok: true }`. A stale wake (an entity has handled a newer
 *    generation) is never acked. A failed entity wake answers 503, and the
 *    server redelivers the wake; every step is idempotent.
 */
import { Hono } from 'hono';
import {
	entityKey,
	entityOfInboxPath,
	entityOfObserveSubscription,
	logPathFromWire,
	wirePath,
} from './paths.ts';
import type { EntityRef } from './services.ts';
import type { EntityWakeRequest, EntityWakeResult, EntityWakeStream } from './wake-handler.ts';
import {
	acknowledgeWakeNotice,
	receiveWakeNotice,
	type WakeAckResult,
	type WakeNotice,
	type WebhookKeyResolver,
} from './webhook.ts';

export const ENTITY_WAKE_ROUTE_PATH = '/__flue/streams/wake';

export interface EntityWakeRouteOptions {
	/** Verification keys: `jwksWebhookKeys({ url: webhookJwksUrl(<agents-server public URL>) })`. */
	readonly keys: WebhookKeyResolver;
	/** Deliver one entity's share of the wake: `stub(idFromName(entity)).__flueWake(request)`. */
	readonly wake: (entity: EntityRef, request: EntityWakeRequest) => Promise<EntityWakeResult>;
	/** For callback acks. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	readonly now?: () => number;
	readonly toleranceSeconds?: number;
	/** Default {@link ENTITY_WAKE_ROUTE_PATH}. */
	readonly path?: string;
	readonly onReport?: (error: unknown) => void;
}

/** What the route decided for one wake (also its JSON reply for tests and logs). */
export interface EntityWakeRouteOutcome {
	readonly entities: readonly string[];
	readonly acked: 'done-reply' | 'callback' | 'stale' | 'fenced' | 'nothing';
}

interface Target {
	readonly entity: EntityRef;
	readonly streams: EntityWakeStream[];
}

/** Split a wake into per-entity requests. Streams no entity owns are returned apart. */
export function routeWakeNotice(notice: WakeNotice): { targets: Target[]; unowned: string[] } {
	const targets = new Map<string, Target>();
	const unowned: string[] = [];
	const observer = entityOfObserveSubscription(notice.subscriptionId);
	for (const stream of notice.streams) {
		if (!stream.pending) continue;
		const path = logPathFromWire(stream.path);
		const entity = observer ?? entityOfInboxPath(path);
		if (!entity) {
			unowned.push(stream.path);
			continue;
		}
		const key = entityKey(entity);
		let target = targets.get(key);
		if (!target) {
			target = { entity, streams: [] };
			targets.set(key, target);
		}
		target.streams.push({ path, tailOffset: stream.tailOffset });
	}
	return { targets: [...targets.values()], unowned };
}

export function createEntityWakeRoute(options: EntityWakeRouteOptions): Hono {
	const app = new Hono();
	const report = options.onReport ?? (() => {});
	app.post(options.path ?? ENTITY_WAKE_ROUTE_PATH, async (c) => {
		const received = await receiveWakeNotice(c.req.raw, {
			keys: options.keys,
			...(options.now ? { now: options.now } : {}),
			...(options.toleranceSeconds === undefined
				? {}
				: { toleranceSeconds: options.toleranceSeconds }),
		});
		if (!received.ok) return c.json({ error: received.reason }, received.status);
		const { notice } = received;
		const { targets, unowned } = routeWakeNotice(notice);

		const settled = await Promise.allSettled(
			targets.map((target) =>
				options.wake(target.entity, {
					subscriptionId: notice.subscriptionId,
					generation: notice.generation,
					streams: target.streams,
				}),
			),
		);
		const failed = settled.filter((result) => result.status === 'rejected');
		if (failed.length > 0) {
			for (const failure of failed) report((failure as PromiseRejectedResult).reason);
			return c.json({ error: 'entity wake failed; redeliver' }, 503);
		}
		const results = settled.map(
			(result) => (result as PromiseFulfilledResult<EntityWakeResult>).value,
		);
		const entities = targets.map((target) => entityKey(target.entity));
		if (results.some((result) => result.stale)) {
			const outcome: EntityWakeRouteOutcome = { entities, acked: 'stale' };
			return c.json({ ok: true, ...outcome });
		}

		const acks: { stream: string; offset: string }[] = [];
		let allDone = true;
		for (const result of results) {
			for (const stream of result.streams) {
				if (!stream.done) allDone = false;
				if (stream.processedThrough !== '-1') {
					acks.push({ stream: wirePath(stream.path), offset: stream.processedThrough });
				}
			}
		}
		// Streams no Flue entity owns are not ours to hold up: ack their snapshot.
		for (const path of unowned) {
			const tail = notice.streams.find((stream) => stream.path === path)?.tailOffset;
			if (tail !== undefined) acks.push({ stream: path, offset: tail });
		}

		if (notice.format === 'durable-streams' && allDone) {
			const outcome: EntityWakeRouteOutcome = { entities, acked: 'done-reply' };
			return c.json({ done: true, ...outcome });
		}
		const acked = await ackOrReport(notice, acks, options, report);
		const outcome: EntityWakeRouteOutcome = { entities, acked };
		return c.json({ ok: true, ...outcome });
	});
	return app;
}

async function ackOrReport(
	notice: WakeNotice,
	acks: { stream: string; offset: string }[],
	options: EntityWakeRouteOptions,
	report: (error: unknown) => void,
): Promise<EntityWakeRouteOutcome['acked']> {
	let result: WakeAckResult;
	try {
		result = await acknowledgeWakeNotice(
			notice,
			{ acks, done: true },
			options.fetch ? { fetch: options.fetch } : {},
		);
	} catch (error) {
		// The work is admitted; an unacked wake only expires and is redelivered.
		report(error);
		return 'nothing';
	}
	return result.status === 'fenced' ? 'fenced' : 'callback';
}
