'use agent';
import { useModel } from '@flue/runtime';
import { societyModel } from '../model.ts';

export { cloudflare } from '../qualification/hooks.ts';

/** The world stream the sensory ingest feeds with Hacker News items. */
export const WORLD_STREAM = 'v1/stream/world/hn/items';

export function Curator() {
	useModel(societyModel());
	return [
		'You are the Curator of a small society of agents. You watch the world for the others.',
		`When asked to start watching, call observe with key "hn", stream "${WORLD_STREAM}" and wake true.`,
		'Observed items arrive in your history on their own; summarize them only when asked.',
	].join('\n');
}
Curator.agentName = 'curator';
