/**
 * Fabric governed-effect admission via OperationPort (live-artifacts A7).
 *
 * Callers never supply a fabricAdmitted boolean. Admission is decided by
 * creating a fabric.governed.admit operation and reading its structured result.
 */

import type { OperationPort } from '../../mcp-server/ports.ts';
import type { FabricAdmissionVerifier } from './fabric-admission.ts';

export const FABRIC_GOVERNED_ADMIT_CAPABILITY = 'fabric.governed.admit';

export class OperationPortFabricAdmission implements FabricAdmissionVerifier {
	constructor(private readonly operationPort: OperationPort) {}

	async isAdmitted(input: {
		artifactId: string;
		tenantId: string;
		toolName: string;
		principal: string;
	}): Promise<boolean> {
		const op = await Promise.resolve(
			this.operationPort.createOperation({
				capabilityId: FABRIC_GOVERNED_ADMIT_CAPABILITY,
				payload: input,
				state: 'running',
				initialSummary: `Fabric admission for ${input.toolName}`,
			}),
		);
		const latest = await Promise.resolve(this.operationPort.getOperation(op.operationId));
		const admitted = latest?.result?.structuredContent?.admitted;
		return admitted === true;
	}
}

/** Test/production helper: OperationPort that auto-admits fabric.governed.admit. */
export function wireAutoAdmitGovernedOperations(operationPort: OperationPort): void {
	const originalCreate = operationPort.createOperation.bind(operationPort);
	operationPort.createOperation = (params) => {
		const op = originalCreate(params);
		if (params.capabilityId === FABRIC_GOVERNED_ADMIT_CAPABILITY) {
			const payload = params.payload ?? {};
			const deniedTools = Array.isArray(payload.deniedTools)
				? (payload.deniedTools as string[])
				: [];
			const admitted = !deniedTools.includes(String(payload.toolName ?? ''));
			operationPort.updateOperation(op.operationId, {
				state: 'completed',
				result: {
					resultType: 'complete',
					content: [{ type: 'text', text: admitted ? 'admitted' : 'denied' }],
					structuredContent: { admitted, policy: 'fabric.governed.admit' },
				},
			});
		}
		return op;
	};
}
