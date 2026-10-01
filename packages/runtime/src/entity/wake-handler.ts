/**
 * The per-entity wake handler: what a coordinator's `__flueWake(request)` RPC
 * delegates to (PI_UPGRADE_PLAN.md §2.5 "Wake"). Pure over an
 * {@link EntityRuntime}: no Cloudflare, no HTTP.
 *
 * ## Contract for the coordinators (lane-cutover)
 *
 * `cloudflare/flue-agent-class.ts` (and the Node coordinator) expose
 *
 * ```ts
 * async __flueWake(request: EntityWakeRequest): Promise<EntityWakeResult> {
 *   await this.ensurePiHostOpen();        // StreamStorage.open + Harness.open + applyRender (reconstructs)
 *   return handleEntityWake(this.entityRuntime, request, context);
 * }
 * ```
 *
 * - The Worker route (`webhook-route.ts`) calls it on
 *   `env.<AGENT_NAMESPACE>.get(env.<AGENT_NAMESPACE>.idFromName(<instance name>))`
 *   — the same DO naming `admitDispatch` uses — once per entity in a wake.
 * - `request.streams` are **log paths** (`flue/v1/{type}/{id}/inbox`, or an
 *   observed stream such as `world/hn/items`), each with the tail offset the
 *   wake snapshotted.
 * - The handler is idempotent and at-least-once safe: admission dedups by
 *   request id and cursors only move forward. A `generation` below the
 *   highest one this entity handled for the subscription is still processed
 *   but reported `stale`, and the route then never acks it.
 * - It returns once messages are **admitted**, not once Pi has answered
 *   them: Pi runs on in the DO (the coordinator keeps its live-task alarm).
 * - It throws only for failures worth a retry (storage, a log outage); the
 *   route then leaves the wake un-acked and Durable Streams redelivers it.
 */
import type { Context } from '@earendil-works/chord';
import { compareOffsets } from '../streams/offset.ts';
import type { EntityRuntime } from './runtime.ts';

export interface EntityWakeStream {
	/** Log path of a stream in the wake. */
	readonly path: string;
	/** The stream's tail when the wake was issued; omitted when unknown. */
	readonly tailOffset?: string;
}

export interface EntityWakeRequest {
	readonly subscriptionId: string;
	/** The subscription's wake generation (fencing counter). */
	readonly generation: number;
	readonly streams: readonly EntityWakeStream[];
}

export interface EntityWakeStreamResult {
	readonly path: string;
	/** Offset through which this entity handled the stream (`-1`: nothing). */
	readonly processedThrough: string;
	/** `processedThrough` reached the wake's tail offset. */
	readonly done: boolean;
}

export interface EntityWakeResult {
	/** The wake's generation is older than one this entity already handled. */
	readonly stale: boolean;
	readonly streams: readonly EntityWakeStreamResult[];
	/** Submission ids admitted from the inbox in this wake. */
	readonly admitted: readonly string[];
}

function generationKey(subscriptionId: string): string {
	return `wake-generation:${subscriptionId}`;
}

function reached(processedThrough: string, tailOffset: string | undefined): boolean {
	return tailOffset === undefined || compareOffsets(processedThrough, tailOffset) >= 0;
}

export async function handleEntityWake(
	runtime: EntityRuntime,
	request: EntityWakeRequest,
	context: Context,
): Promise<EntityWakeResult> {
	const cursors = runtime.cursors();
	const seen = Number(cursors.get(generationKey(request.subscriptionId)) ?? '-1');
	// A stale wake is still processed — processing is idempotent, and a server
	// that lost its subscription state restarts generations from 0, which
	// must not starve the entity — but it is reported, so the route never
	// acks it (a late `{done:true}` would ack a newer wake's snapshot).
	const stale = Number.isFinite(seen) && request.generation < seen;

	// Schedules that came due while asleep go first: they are older than anything in this wake.
	await runtime.schedules.fireDue(context);

	const results: EntityWakeStreamResult[] = [];
	const admitted: string[] = [];
	for (const stream of request.streams) {
		if (stream.path === runtime.inbox.path) {
			const drained = await runtime.inbox.drain(context);
			admitted.push(...drained.admitted);
			results.push({
				path: stream.path,
				processedThrough: drained.processedThrough,
				done: reached(drained.processedThrough, stream.tailOffset),
			});
			continue;
		}
		const keys = await runtime.observations.keysFor(stream.path, context);
		let processedThrough: string | undefined;
		for (const key of keys) {
			const observation = await runtime.observations.read(key, context);
			if (!observation?.wake) continue;
			const batch = await runtime.observation.poll(key, {}, context);
			if (processedThrough === undefined || compareOffsets(batch.nextOffset, processedThrough) < 0) {
				processedThrough = batch.nextOffset;
			}
		}
		// Nothing here observes it (any more): there is nothing to do, so the wake's tail is handled.
		const through = processedThrough ?? stream.tailOffset ?? '-1';
		results.push({ path: stream.path, processedThrough: through, done: reached(through, stream.tailOffset) });
	}

	await runtime.host.wake(
		request.streams[0]
			? { kind: 'inbox', stream: request.streams[0].path, tailOffset: request.streams[0].tailOffset ?? '-1' }
			: { kind: 'dispatch' },
		context,
	);
	if (!Number.isFinite(seen) || request.generation > seen) {
		await cursors.set(generationKey(request.subscriptionId), String(request.generation));
	}
	return { stale, streams: results, admitted };
}
