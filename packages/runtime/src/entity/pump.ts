/**
 * The alarm pump (docs/cloudflare-native.md rule 4): drain every stream the
 * wake book (`wake-book.ts`) holds behind its head, from its committed cursor,
 * in bounded chunks. Each inbox event is admitted as an idempotent Pi
 * submission keyed by its event id (`inbox.ts`), then the cursor advances;
 * an observed stream is polled into `flue.observed` writes keyed the same way
 * (`observations.ts`). The pump returns whether anything is still behind, and
 * the caller re-arms the alarm while it is.
 *
 * Pi turns never have to fit in one pump: admission only queues the
 * submission and returns. Pi Durable runs the turn after the pump returns,
 * and resumes it on later wakes if the object is evicted mid-turn (the live
 * task backstop, `pi/host.ts`).
 *
 * ## Chunk sizes
 *
 * Designed against Cloudflare's published limits (developers.cloudflare.com,
 * read 2026-10-01):
 *
 * - Durable Object alarm handlers have a maximum wall time of 15 minutes
 *   (/workers/platform/limits/, "Duration").
 * - CPU: 30 seconds of active CPU per invocation by default, configurable up
 *   to 5 minutes (/durable-objects/platform/limits/, "CPU per request").
 * - Subrequests: 10,000 per invocation on Workers Paid, configurable up to
 *   10M; 50 on Workers Free (/workers/platform/limits/, "Subrequests").
 *
 * One pump reads at most {@link PUMP_LIMITS.reads} batches (one subrequest
 * each) and admits at most {@link PUMP_LIMITS.events} events, and stops
 * starting new batches after {@link PUMP_LIMITS.wallMs} of wall time. An
 * admission is local SQLite work plus a render (milliseconds of CPU), so a
 * full pump stays far inside the 30 s CPU default and the 15 min wall limit,
 * and its 16 reads leave the subrequest budget to the model calls of the
 * turns it starts — the per-invocation exhaustion of #3797 cannot recur,
 * because no Pi commit posts anything anywhere.
 */
import type { Context } from '@earendil-works/chord';
import { compareOffsets } from '../streams/offset.ts';
import type { EntityRuntime } from './runtime.ts';
import type { EntityWakeBook } from './wake-book.ts';

export interface PumpLimits {
	/** Inbox/observed-stream reads per pump (each is one subrequest). */
	readonly reads: number;
	/** Events admitted per pump. */
	readonly events: number;
	/** Wall time after which no new batch is started (ms). */
	readonly wallMs: number;
}

export const PUMP_LIMITS: PumpLimits = { reads: 16, events: 64, wallMs: 10_000 };

export interface PumpResult {
	/** Some stream is still behind its head: re-arm. */
	readonly behind: boolean;
	/** Submission ids admitted (or found already admitted) from the inbox. */
	readonly admitted: readonly string[];
	/** Question ids an `input-answered` inbox event settled. */
	readonly answered: readonly string[];
	readonly events: number;
	readonly reads: number;
}

export async function pumpEntity(
	runtime: EntityRuntime,
	book: EntityWakeBook,
	context: Context,
	options: { readonly limits?: PumpLimits; readonly now?: () => number } = {},
): Promise<PumpResult> {
	const limits = options.limits ?? PUMP_LIMITS;
	const now = options.now ?? Date.now;
	const deadline = now() + limits.wallMs;
	const admitted: string[] = [];
	const answered: string[] = [];
	let events = 0;
	let reads = 0;
	const spent = () => reads >= limits.reads || events >= limits.events || now() >= deadline;

	for (const stream of book.pending()) {
		if (spent()) break;
		if (stream.path === runtime.inbox.path) {
			let cursor = stream.cursor;
			while (!spent() && compareOffsets(cursor, stream.head) < 0) {
				const batch = await runtime.inbox.batch(cursor as never, context);
				reads++;
				events += batch.events;
				admitted.push(...batch.admitted);
				answered.push(...batch.answered);
				// Caught up short of a head the server reported: the head is
				// reached as far as this stream will ever say.
				const next =
					batch.upToDate && compareOffsets(batch.nextOffset, stream.head) < 0
						? stream.head
						: batch.nextOffset;
				book.advance(stream.path, next);
				if (next === cursor) break;
				cursor = next;
			}
			continue;
		}
		// A stream this entity observes: poll every observation that wakes on it.
		let through: string | undefined;
		let caughtUp = true;
		for (const key of await runtime.observations.keysFor(stream.path, context)) {
			const observation = await runtime.observations.read(key, context);
			if (!observation?.wake) continue;
			if (spent()) {
				caughtUp = false;
				break;
			}
			const batch = await runtime.observation.poll(
				key,
				{ limit: Math.max(1, limits.events - events) },
				context,
			);
			reads++;
			events += batch.items.length;
			if (!batch.upToDate) caughtUp = false;
			if (through === undefined || compareOffsets(batch.nextOffset, through) < 0)
				through = batch.nextOffset;
		}
		// Nothing observes it (any more), or every observer caught up: its head is handled.
		if (caughtUp) book.advance(stream.path, stream.head);
		else if (through !== undefined) book.advance(stream.path, through);
	}
	return { behind: book.behind(), admitted, answered, events, reads };
}
