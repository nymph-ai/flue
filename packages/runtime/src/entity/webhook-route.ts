/**
 * `POST /__flue/streams/wake` — the Worker route Electric's webhook
 * subscriptions call (docs/cloudflare-native.md rule 3: wakes are doorbells).
 *
 * 1. Verify the Ed25519 `webhook-signature` against the JWKS and parse the
 *    wake, from the agents-server (primary) or a bare Durable Streams server
 *    (`webhook.ts`). 401 / 400 otherwise.
 * 2. Map streams to entities: on an observe subscription
 *    (`flue-obs.<type>.<id>`, `paths.ts`) every pending stream belongs to the
 *    entity its (signed) id names; otherwise each pending
 *    `flue/v1/{type}/{id}/inbox` belongs to that entity.
 * 3. Ring each entity's doorbell, once per stream — on Cloudflare the
 *    `__flueWake({ stream, head })` RPC of `getByName(entity)`, which writes
 *    the stream's high-water mark in the same synchronous turn as the wake
 *    job it arms and returns. Nothing is processed here; the wake pumps.
 * 4. Once every doorbell resolved — the heads are durable — ack the wake's
 *    tails through its callback with `done: true`, so the server re-wakes
 *    only for events appended later. The reply is `{ ok: true }`, never
 *    `{ done: true }`: behind the agents-server that reply would ack streams
 *    the Worker never saw. A failed doorbell answers 503 and acks nothing;
 *    the server redelivers, and ringing again is idempotent. A stale wake is
 *    acked like any other: the server fences an outdated generation itself.
 */
import { Hono } from 'hono';
import {
	entityKey,
	entityOfInboxPath,
	entityOfObserveSubscription,
	logPathFromWire,
	MCP_EVENTS_SUBSCRIPTION_ID,
} from './paths.ts';
import type { EntityRef } from './services.ts';
import {
	acknowledgeWakeNotice,
	receiveWakeNotice,
	type WakeAckResult,
	type WakeNotice,
	type WebhookKeyResolver,
} from './webhook.ts';

export const ENTITY_WAKE_ROUTE_PATH = '/__flue/streams/wake';

/** One doorbell: `stream` (a log path) holds events through `head`. */
export interface EntityDoorbell {
	readonly stream: string;
	readonly head: string;
}

export interface EntityWakeRouteOptions {
	/** Verification keys: `jwksWebhookKeys({ url: webhookJwksUrl(<agents-server public URL>) })`. */
	readonly keys: WebhookKeyResolver;
	/** Ring one entity's doorbell: `stub(idFromName(entity)).__flueWake({ stream, head })`. */
	readonly wake: (entity: EntityRef, doorbell: EntityDoorbell) => Promise<unknown>;
	/** Ring MCP subscription doorbell: `stub.__mcpWake({ stream, head })`. */
	readonly mcpWake?: (doorbell: EntityDoorbell) => Promise<unknown>;
	/** The subscription ID for MCP events (default: MCP_EVENTS_SUBSCRIPTION_ID). */
	readonly mcpEventsSubscriptionId?: string;
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
	readonly acked: 'callback' | 'fenced' | 'nothing';
}

interface Target {
	readonly entity: EntityRef;
	readonly doorbells: EntityDoorbell[];
}

/** Split a wake into per-entity doorbells. Streams no entity owns are returned apart. */
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
			target = { entity, doorbells: [] };
			targets.set(key, target);
		}
		target.doorbells.push({ stream: path, head: stream.tailOffset });
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
		const mcpSubscriptionId = options.mcpEventsSubscriptionId ?? MCP_EVENTS_SUBSCRIPTION_ID;
		const isMcpNotice = notice.subscriptionId === mcpSubscriptionId;

		let wakePromises: Promise<unknown>[] = [];
		let entities: string[] = [];

		if (isMcpNotice) {
			if (options.mcpWake) {
				for (const stream of notice.streams) {
					if (!stream.pending) continue;
					const path = logPathFromWire(stream.path);
					wakePromises.push(options.mcpWake({ stream: path, head: stream.tailOffset }));
				}
			}
		} else {
			const { targets } = routeWakeNotice(notice);
			wakePromises = targets.flatMap((target) =>
				target.doorbells.map((doorbell) => options.wake(target.entity, doorbell)),
			);
			entities = targets.map((target) => entityKey(target.entity));
		}

		const settled = await Promise.allSettled(wakePromises);
		const failed = settled.filter((result) => result.status === 'rejected');
		if (failed.length > 0) {
			for (const failure of failed) report((failure as PromiseRejectedResult).reason);
			return c.json({ error: 'entity wake failed; redeliver' }, 503);
		}

		// Every head is durable in its entity: ack the tails the wake carried —
		// those of streams no Flue entity owns too, which are not ours to hold up.
		const acks: { stream: string; offset: string }[] = [];
		for (const stream of notice.streams) {
			if (stream.pending) acks.push({ stream: stream.path, offset: stream.tailOffset });
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
		// The heads are recorded; an unacked wake only expires and is redelivered.
		report(error);
		return 'nothing';
	}
	return result.status === 'fenced' ? 'fenced' : 'callback';
}
