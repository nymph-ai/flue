/**
 * Which model the society runs, chosen by the deployment's `SOCIETY_MODEL`
 * var: `scripted` (the default — a deterministic provider over pi-ai's faux
 * model, for reproducible qualification runs) or `workers-ai` (Cloudflare
 * Workers AI through the `AI` binding, model `WORKERS_AI_MODEL`).
 */
import { env } from 'cloudflare:workers';
import { setProvider } from '@flue/runtime';
import { SCRIPTED_MODEL, SCRIPTED_PROVIDER, scriptedProvider } from './scripted.ts';

const vars = env as unknown as Record<string, string | undefined>;

setProvider(scriptedProvider({ tokensPerSecond: Number(vars.SCRIPTED_TOKENS_PER_SECOND ?? '50') }));

export function societyModel(): string {
	if (vars.SOCIETY_MODEL === 'workers-ai') {
		return `cloudflare/${vars.WORKERS_AI_MODEL ?? '@cf/moonshotai/kimi-k2.6'}`;
	}
	return `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`;
}
