/**
 * Entity-layer Pi documents and entries, beside the ones `pi/docs.ts` owns
 * (`flue.schedules`, `flue.observations`). They are Pi state in the entity's
 * own SQLite: its schedules and observation cursors.
 */
import type { JsonValue } from '@earendil-works/chord';
import { defineDoc, defineEntry } from '@earendil-works/pi-durable';
import { boundedDeltas } from '../pi/docs.ts';
import type { DeliveredMessage } from '../types.ts';

/** Armed schedules by key, with their due time: what a wake scans. */
export type FlueScheduleIndexState = { armed: { [key: string]: number } };

export const FlueScheduleIndex = defineDoc<FlueScheduleIndexState>({
	kind: 'flue.schedule-index',
	version: 1,
	checkpointWhen: boundedDeltas,
	scope: 'session',
	initial: () => ({ armed: {} }),
});

/** Observation keys by stream log path. */
export type FlueObservationIndexState = { keys: { [key: string]: string } };

export const FlueObservationIndex = defineDoc<FlueObservationIndexState>({
	kind: 'flue.observation-index',
	version: 1,
	checkpointWhen: boundedDeltas,
	scope: 'session',
	initial: () => ({ keys: {} }),
});

/** An observed item, recorded by a write submission (`requestId = "obs:{key}@{offset}:{index}"`). */
export type FlueObservedData = {
	key: string;
	stream: string;
	/** The offset the read started from; with `index`, the item's position. */
	offset: string;
	index: number;
	item: JsonValue;
};

export const FlueObservedEntry = defineEntry<FlueObservedData>('flue.observed');

/** JSON form of a `DeliveredMessage` as it is stored in schedule docs. */
export function deliveredMessageJson(message: DeliveredMessage): JsonValue {
	return JSON.parse(JSON.stringify(message)) as JsonValue;
}
