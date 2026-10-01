/**
 * Observation (docs/cloudflare-native.md rules 4–5): read another stream past
 * a cursor and record each item in this entity's own history as a Pi
 * **write** submission of entry kind `flue.observed`. The request id is the
 * item's event id when it is another entity's published event
 * (`obs:{key}#{publisher}/{eventId}`) — a publisher's replayed tool call may
 * append the same event twice, and it is recorded once — and otherwise its
 * position, `obs:{key}@{offset}:{index}`: `offset` is where the read started
 * and `index` the item's place in what it returned. Reads never split an
 * append and always restart from the committed cursor, so a re-poll after a
 * crash re-derives the same ids and Pi's `submissionByRequest` admits each
 * item once.
 *
 * Cursors live in the `flue.observations` doc; `flue.observation-index` maps
 * keys to stream paths for wakes.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import { FlueObservations } from '../pi/docs.ts';
import type { FluePiHost } from '../pi/host.ts';
import { DurableStreamLogError, type DurableStreamLog } from '../streams/log.ts';
import { asStreamOffset, isResumeOffset, STREAM_START } from '../streams/offset.ts';
import { FlueObservationIndex, FlueObservedEntry } from './docs.ts';
import { entityKey, eventsPath } from './paths.ts';
import type { ObservedBatch, ObservationCursors, ObserveSource } from './services.ts';

export interface ObservationBookOptions {
	readonly host: FluePiHost;
	readonly log: DurableStreamLog;
	readonly now: () => number;
}

/** What `flue.observations[key].source` holds. */
export type ObservationSourceState = { path: string; entity?: { type: string; id: string } };

/** The request id an observed item is admitted with: its event id if it has one, else its position. */
export function observedRequestId(
	key: string,
	offset: string,
	index: number,
	item?: unknown,
): string {
	const event = item as { type?: unknown; from?: unknown; eventId?: unknown } | null | undefined;
	if (
		event?.type === 'flue.event' &&
		typeof event.eventId === 'string' &&
		typeof event.from === 'object' &&
		event.from !== null &&
		typeof (event.from as { type?: unknown }).type === 'string' &&
		typeof (event.from as { id?: unknown }).id === 'string'
	) {
		return `obs:${key}#${entityKey(event.from as { type: string; id: string })}/${event.eventId}`;
	}
	return `obs:${key}@${offset}:${index}`;
}

export function sourcePath(source: ObserveSource): string {
	if ('stream' in source) {
		if (typeof source.stream !== 'string' || source.stream.length === 0) {
			throw new TypeError('[flue] An observed stream needs a path.');
		}
		return source.stream.replace(/^\/+/, '');
	}
	return eventsPath(source.entity);
}

export class ObservationBook {
	readonly #options: ObservationBookOptions;

	constructor(options: ObservationBookOptions) {
		this.#options = options;
	}

	/** Start (or update) an observation; the cursor is kept unless `from` is given. */
	async observe(
		source: ObserveSource,
		options: { readonly key: string; readonly from?: string; readonly wake?: boolean },
		context: Context,
	): Promise<{ readonly key: string; readonly offset: string; readonly path: string }> {
		const { key } = options;
		if (typeof key !== 'string' || key.length === 0)
			throw new TypeError('[flue] An observation needs a key.');
		if (options.from !== undefined && !isResumeOffset(options.from)) {
			throw new TypeError(`[flue] "${options.from}" is not a resume offset.`);
		}
		const path = sourcePath(source);
		const sourceState: ObservationSourceState =
			'entity' in source
				? { path, entity: { type: source.entity.type, id: source.entity.id } }
				: { path };
		const now = this.#options.now();
		const offset = await this.#options.host.harness.commit(async (tx) => {
			const observation = await tx.doc(FlueObservations, key, null);
			const existing = observation.source as ObservationSourceState | null;
			if (existing !== null && existing.path !== path) {
				throw new TypeError(`[flue] Observation "${key}" already observes "${existing.path}".`);
			}
			if (existing === null) {
				observation.source = sourceState as unknown as JsonValue;
				observation.offset = options.from ?? STREAM_START;
			} else if (options.from !== undefined) {
				observation.offset = options.from;
			}
			if (options.wake !== undefined) observation.wake = options.wake;
			observation.updatedAt = now;
			const index = await tx.doc(FlueObservationIndex);
			index.keys[key] = path;
			return observation.offset;
		}, context);
		return { key, offset, path };
	}

	async read(
		key: string,
		context: Context,
	): Promise<
		{ readonly path: string; readonly offset: string; readonly wake: boolean } | undefined
	> {
		const state = await this.#options.host.harness.snapshot(FlueObservations, key, context);
		const source = state?.source as ObservationSourceState | null | undefined;
		if (!state || !source) return undefined;
		return { path: source.path, offset: state.offset, wake: state.wake };
	}

	/** Keys observing `path` (log path). */
	async keysFor(path: string, context: Context): Promise<string[]> {
		const index = await this.#options.host.harness.snapshot(FlueObservationIndex, context);
		return Object.entries(index?.keys ?? {})
			.filter(([, observed]) => observed === path)
			.map(([key]) => key)
			.sort();
	}

	async cursors(context: Context): Promise<ObservationCursors> {
		const index = await this.#options.host.harness.snapshot(FlueObservationIndex, context);
		const cursors: Record<string, { offset: string; updatedAt: number }> = {};
		for (const key of Object.keys(index?.keys ?? {}).sort()) {
			const state = await this.#options.host.harness.snapshot(FlueObservations, key, context);
			if (state?.source) cursors[key] = { offset: state.offset, updatedAt: state.updatedAt };
		}
		return cursors;
	}

	/** Record what lies past the cursor, then advance it. */
	async poll(
		key: string,
		options: { readonly limit?: number },
		context: Context,
	): Promise<ObservedBatch> {
		const { host, log, now } = this.#options;
		const observation = await this.read(key, context);
		if (!observation) throw new TypeError(`[flue] Unknown observation "${key}".`);
		const limit = options.limit ?? Number.POSITIVE_INFINITY;
		const root = await host.harness.root(context);
		const items: JsonValue[] = [];
		let offset = observation.offset;
		let upToDate = false;
		while (items.length < limit) {
			let batch: Awaited<ReturnType<DurableStreamLog['read']>>;
			try {
				batch = await log.read(observation.path, asStreamOffset(offset));
			} catch (error) {
				if (error instanceof DurableStreamLogError && error.code === 'not-found') {
					upToDate = true;
					break;
				}
				throw error;
			}
			for (const [index, item] of batch.messages.entries()) {
				const value = item as JsonValue;
				await root.submit(
					{
						type: 'write',
						requestId: observedRequestId(key, offset, index, value),
						entry: {
							kind: FlueObservedEntry.kind,
							data: { key, stream: observation.path, offset, index, item: value },
						},
					},
					context,
				);
				items.push(value);
			}
			const next = batch.nextOffset;
			if (next !== offset) {
				await host.harness.commit(async (tx) => {
					const draft = await tx.doc(FlueObservations, key, null);
					draft.offset = next;
					draft.updatedAt = now();
				}, context);
				offset = next;
			}
			upToDate = batch.upToDate;
			if (batch.upToDate || batch.messages.length === 0) break;
		}
		return { items, nextOffset: offset, upToDate };
	}

	/** Stop observing; returns the path it observed and whether it woke this entity. */
	async unobserve(
		key: string,
		context: Context,
	): Promise<
		{ readonly path: string; readonly wake: boolean; readonly stillObserved: boolean } | undefined
	> {
		const observation = await this.read(key, context);
		if (!observation) return undefined;
		await this.#options.host.harness.commit(async (tx) => {
			await tx.retireDoc(FlueObservations, key);
			const index = await tx.doc(FlueObservationIndex);
			delete index.keys[key];
		}, context);
		const stillObserved = (await this.keysFor(observation.path, context)).length > 0;
		return { path: observation.path, wake: observation.wake, stillObserved };
	}
}
