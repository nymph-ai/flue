import { describe, expect, it } from 'vitest';
import { OperationStore } from '../../mcp-server/operations.ts';
import {
	FABRIC_GOVERNED_ADMIT_CAPABILITY,
	OperationPortFabricAdmission,
	wireAutoAdmitGovernedOperations,
} from './operation-port-admission.ts';

describe('OperationPortFabricAdmission', () => {
	it('admits when the governed operation completes with admitted: true', async () => {
		const port = new OperationStore();
		wireAutoAdmitGovernedOperations(port);
		const admission = new OperationPortFabricAdmission(port);
		const ok = await admission.isAdmitted({
			artifactId: 'artifact://t/a',
			tenantId: 't',
			toolName: 'artifact.score.set',
			principal: 'user:alice',
		});
		expect(ok).toBe(true);
		const ops = [...port.listOperations()];
		expect(ops.some((op) => op.capabilityId === FABRIC_GOVERNED_ADMIT_CAPABILITY)).toBe(true);
	});

	it('denies when deniedTools includes the tool name', async () => {
		const port = new OperationStore();
		wireAutoAdmitGovernedOperations(port);
		const admission = new OperationPortFabricAdmission(port);
		const originalCreate = port.createOperation.bind(port);
		port.createOperation = (params) => {
			if (params.capabilityId === FABRIC_GOVERNED_ADMIT_CAPABILITY) {
				return originalCreate({
					...params,
					payload: { ...params.payload, deniedTools: ['admin.wipe'] },
				});
			}
			return originalCreate(params);
		};
		const ok = await admission.isAdmitted({
			artifactId: 'artifact://t/a',
			tenantId: 't',
			toolName: 'admin.wipe',
			principal: 'user:alice',
		});
		expect(ok).toBe(false);
	});
});
