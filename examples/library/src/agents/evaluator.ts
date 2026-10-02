'use agent';
import { useModel } from '@flue/runtime';
import { liveModel } from '../model.ts';

export { cloudflare } from '../qualification/hooks.ts';

/** Direct query evaluation agent targeting the live model (`LIVE_MODEL`). */
export function Evaluator() {
	useModel(liveModel());
	return 'You are a direct query evaluation agent. Answer in one short sentence.';
}
Evaluator.agentName = 'evaluator';

/** Compatibility alias for qualification harness */
export const Sage = Evaluator;
