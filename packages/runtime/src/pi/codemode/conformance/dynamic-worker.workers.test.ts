import { env } from 'cloudflare:workers';
import { afterAll, describe, expect, it } from 'vitest';
import {
	type CodemodeWorkerLoader,
	DynamicWorkerCodemodeExecutor,
} from '../../../cloudflare/codemode-dynamic-worker.ts';
import { CONFORMANCE_CASES, runConformanceCase } from './corpus.ts';

/**
 * The corpus `node.test.ts` pins to Pi's `CodemodeSandbox`, run against the
 * Dynamic Worker executor inside workerd (Miniflare's Worker Loader).
 */
describe('Code Mode conformance: DynamicWorkerCodemodeExecutor (Worker Loader)', () => {
	const loader = (env as unknown as { LOADER: CodemodeWorkerLoader }).LOADER;
	const executor = new DynamicWorkerCodemodeExecutor({ loader });
	afterAll(() => executor.close());

	for (const testCase of CONFORMANCE_CASES) {
		const reason = testCase.skip?.dynamicWorker;
		if (reason) {
			it.skip(`${testCase.name} (${reason})`, () => {});
			continue;
		}
		it(testCase.name, async () => {
			expect(await runConformanceCase(executor, testCase)).toEqual(testCase.expected);
		});
	}

	it('rejects executions after close()', async () => {
		const closed = new DynamicWorkerCodemodeExecutor({ loader });
		await closed.close();
		await expect(closed.execute('return 1;', [], { timeoutMs: 1000 })).rejects.toThrow('Sandbox is closed');
	});
});
