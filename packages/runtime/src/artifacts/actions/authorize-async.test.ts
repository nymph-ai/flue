import { describe, expect, it } from 'vitest';
import { OperationStore } from '../../mcp-server/operations.ts';
import { authorizeArtifactActionAsync } from './authorize-async.ts';
import { OperationPortFabricAdmission, wireAutoAdmitGovernedOperations } from './operation-port-admission.ts';

const claims = {
	artifactId: 'artifact://tenant-alpha/scoreboard',
	tenantId: 'tenant-alpha',
	principal: 'user:alice',
	tools: ['artifact.score.set'],
	exp: 9,
};

describe('authorizeArtifactActionAsync', () => {
	it('uses OperationPort policy instead of a caller-supplied fabricAdmitted flag', async () => {
		const port = new OperationStore();
		wireAutoAdmitGovernedOperations(port);
		const decision = await authorizeArtifactActionAsync({
			claims,
			artifactId: claims.artifactId,
			tenantId: claims.tenantId,
			toolName: 'artifact.score.set',
			appOnlyTools: [],
			allowedTools: ['artifact.score.set'],
			revoked: false,
			requiresFabricAdmission: true,
			fabricAdmission: new OperationPortFabricAdmission(port),
		});
		expect(decision.allowed).toBe(true);
	});

	it('denies governed tools when no verifier is configured', async () => {
		const decision = await authorizeArtifactActionAsync({
			claims,
			artifactId: claims.artifactId,
			tenantId: claims.tenantId,
			toolName: 'artifact.score.set',
			appOnlyTools: [],
			allowedTools: ['artifact.score.set'],
			revoked: false,
			requiresFabricAdmission: true,
		});
		expect(decision).toMatchObject({ allowed: false, code: 'FABRIC_ADMISSION_DENIED' });
	});
});
