'use agent';
import { env } from 'cloudflare:workers';
import { useModel } from '@flue/runtime';

export { cloudflare } from '../qualification/hooks.ts';

const vars = env as unknown as Record<string, string | undefined>;

/** The sage always answers with a real model: Workers AI through the `AI` binding. */
export function Sage() {
	useModel(`cloudflare/${vars.SAGE_MODEL ?? vars.WORKERS_AI_MODEL ?? '@cf/moonshotai/kimi-k2.6'}`);
	return 'You are the Sage of a small society of agents. Answer in one short sentence.';
}
Sage.agentName = 'sage';
