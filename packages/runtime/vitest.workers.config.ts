import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Tests that must run inside workerd, through Miniflare: Code Mode's QuickJS
 * sandbox in a Durable Object, and Durable Object SQLite row costs.
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
