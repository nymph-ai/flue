import { defineConfig } from 'vitest/config';

export default defineConfig({
	define: {
		__QUALIFICATION__: 'false',
	},
	test: {
		environment: 'node',
	},
});
