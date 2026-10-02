import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// `*.workers.test.ts` run inside workerd: `vitest.workers.config.ts`.
		exclude: [...configDefaults.exclude, '**/*.workers.test.ts'],
		// The conformance suite (src/qualification) kills an entity's incarnation
		// by making its database and log throw CrashError("the process is dead").
		// What the dead incarnation still had in flight keeps unwinding into
		// promises nobody awaits any more; a dead process cannot be observed, so
		// those rejections are not test failures. Anything else still is.
		onUnhandledError(error) {
			if (error?.name === 'CrashError' && error.message === 'the process is dead') return false;
		},
	},
});
