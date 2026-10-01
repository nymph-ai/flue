/**
 * What `codemode.store(key, value)` keeps between scripts: one Pi document
 * per conversation, written in the same Pi commit discipline as every other
 * Flue value, so it survives eviction and follows the conversation through
 * rewinds and forks. Never isolate memory (docs/cloudflare-native.md, rule 7:
 * a Dynamic Worker owns nothing persistent).
 */
import type { JsonValue } from '@earendil-works/chord';
import { defineDoc } from '@earendil-works/pi-durable';

export type FlueCodemodeStoreState = { values: { [key: string]: JsonValue } };

export const FlueCodemodeStore = defineDoc<FlueCodemodeStoreState>({
	kind: 'flue.codemode.store',
	version: 1,
	scope: 'conversation',
	history: 'rewindable',
	fork: 'asOf',
	initial: () => ({ values: {} }),
});
