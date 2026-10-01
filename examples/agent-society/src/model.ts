/**
 * Which model the society runs, chosen by the deployment's `SOCIETY_MODEL`
 * var: `scripted` (the default — a deterministic provider over pi-ai's faux
 * model, for reproducible qualification runs) or `live` (the real model
 * `LIVE_MODEL`, Muse Spark 1.3 on Meta's Model API).
 */
import { env } from 'cloudflare:workers';
import { setProvider } from '@flue/runtime';
import { SCRIPTED_MODEL, SCRIPTED_PROVIDER, scriptedProvider } from './scripted.ts';

const vars = env as unknown as Record<string, string | undefined>;

setProvider(scriptedProvider({ tokensPerSecond: Number(vars.SCRIPTED_TOKENS_PER_SECOND ?? '50') }));

export function societyModel(): string {
	if (vars.SOCIETY_MODEL === 'live') return liveModel();
	return `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`;
}

/** The real model, keyed by the `META_API_KEY` secret. */
export function liveModel(): string {
	return vars.LIVE_MODEL ?? 'meta/muse-spark-1.3';
}
