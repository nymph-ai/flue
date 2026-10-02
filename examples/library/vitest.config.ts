import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	define: {
		__QUALIFICATION__: 'false',
	},
	test: {
		environment: 'node',
	},
	resolve: {
		alias: {
			'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers-mock.ts', import.meta.url)),
		},
	},
});
