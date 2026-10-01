import { afterAll, describe, expect, it } from 'vitest';
import { NodeCodemodeExecutor } from '../../../node/codemode-node.ts';
import { CONFORMANCE_CASES, runConformanceCase } from './corpus.ts';

/**
 * The corpus against Pi's own `CodemodeSandbox`: this is what makes the
 * expected results Pi's results, not Flue's.
 */
describe('Code Mode conformance: NodeCodemodeExecutor (Pi CodemodeSandbox)', () => {
	const executor = new NodeCodemodeExecutor();
	afterAll(() => executor.close());

	for (const testCase of CONFORMANCE_CASES) {
		it(testCase.name, async () => {
			expect(await runConformanceCase(executor, testCase)).toEqual(testCase.expected);
		});
	}

	it('rejects executions after close()', async () => {
		const closed = new NodeCodemodeExecutor();
		await closed.close();
		await expect(closed.execute('return 1;', [], { timeoutMs: 1000 })).rejects.toThrow('Sandbox is closed');
	});
});
