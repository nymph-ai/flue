'use agent';
import { useModel } from '@flue/runtime';
import { liveModel } from '../model.ts';

export { cloudflare } from '../qualification/hooks.ts';

/** The sage always answers with the real model (`LIVE_MODEL`). */
export function Sage() {
	useModel(liveModel());
	return 'You are the Sage of a small society of agents. Answer in one short sentence.';
}
Sage.agentName = 'sage';
