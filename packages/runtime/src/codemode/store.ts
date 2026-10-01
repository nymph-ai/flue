/**
 * What `codemode.store(key, value)` keeps between scripts: one Pi document
 * per conversation, written in the same Pi commit discipline as every other
 * Flue value, so it survives eviction and follows the conversation through
 * rewinds and forks. Never isolate memory (docs/cloudflare-native.md, rule 7:
 * a Dynamic Worker owns nothing persistent).
 */
import type { JsonValue } from '@earendil-works/chord';
import { defineDoc } from '@earendil-works/pi-durable';
import { boundedDeltas } from '../pi/docs.ts';

export type FlueCodemodeStoreState = { values: { [key: string]: JsonValue } };

export const FlueCodemodeStore = defineDoc<FlueCodemodeStoreState>({
	kind: 'flue.codemode.store',
	version: 1,
	// A base every DELTAS_PER_BASE writes: a read never replays the store's
	// whole history (nymph-ai/nymphai #3862).
	checkpointWhen: boundedDeltas,
	scope: 'conversation',
	history: 'rewindable',
	fork: 'asOf',
	initial: () => ({ values: {} }),
});
