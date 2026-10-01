import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// `*.workers.test.ts` run inside workerd: `vitest.workers.config.ts`.
		exclude: [...configDefaults.exclude, '**/*.workers.test.ts'],
	},
});
