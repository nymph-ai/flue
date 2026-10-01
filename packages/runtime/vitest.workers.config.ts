import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests that must run inside workerd, through Miniflare. The wrangler config
 * declares the Worker Loader binding Code Mode's Dynamic Worker executor uses.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './src/codemode/workers/wrangler.jsonc' },
		}),
	],
	test: {
		include: ['src/**/*.workers.test.ts'],
	},
});
