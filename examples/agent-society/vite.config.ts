import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

// `QUALIFICATION=1 vite build` compiles in the test-only qualification surface
// (fault injection, Durable Object inspection hooks, the /qual admin routes
// and the QualReplica scratch object). Any other build leaves it out entirely.
const qualification = process.env.QUALIFICATION === '1';

export default defineConfig({
	define: { __QUALIFICATION__: JSON.stringify(qualification) },
	plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
