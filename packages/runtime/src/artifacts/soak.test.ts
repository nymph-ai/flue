import { describe, expect, it } from 'vitest';
import { runLocalSoak } from './soak.ts';

describe('local artifact soak', () => {
	it('gives every viewer the same snapshot from one log', async () => {
		const report = await runLocalSoak({ viewers: 40, events: 25 });
		expect(report.distinctSnapshots).toBe(1);
		expect(report.viewers).toBe(40);
		expect(report.events).toBe(25);
		expect(report.sloViewers).toBe(5000);
		expect(report.elapsedMs).toBeLessThan(5000);
	});
});
