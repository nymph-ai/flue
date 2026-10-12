/**
 * Server-side authorization for MCP App actions (P22-A7).
 *
 * Tool visibility (`app` vs `model`) never relaxes this check. Governed
 * effects are flagged for Fabric admission; Electric events do not admit them.
 */

import type { ViewerClaims } from '../auth/tokens.ts';

export interface AuthorizeInput {
	readonly claims: ViewerClaims | null;
	readonly artifactId: string;
	readonly tenantId: string;
	readonly toolName: string;
	readonly appOnlyTools: readonly string[];
	readonly allowedTools: readonly string[];
	readonly revoked: boolean;
	readonly requiresFabricAdmission: boolean;
	readonly fabricAdmitted: boolean;
}

export interface AuthorizeDecision {
	readonly allowed: boolean;
	readonly code?:
		| 'UNAUTHORIZED'
		| 'REVOKED'
		| 'FABRIC_ADMISSION_DENIED'
		| 'ARTIFACT_NOT_FOUND';
	readonly requiresFabricAdmission: boolean;
}

export function authorizeArtifactAction(input: AuthorizeInput): AuthorizeDecision {
	if (!input.claims) {
		return { allowed: false, code: 'UNAUTHORIZED', requiresFabricAdmission: false };
	}
	if (input.claims.artifactId !== input.artifactId || input.claims.tenantId !== input.tenantId) {
		return { allowed: false, code: 'UNAUTHORIZED', requiresFabricAdmission: false };
	}
	if (input.revoked) {
		return { allowed: false, code: 'REVOKED', requiresFabricAdmission: false };
	}
	const known = input.allowedTools.includes(input.toolName) || input.appOnlyTools.includes(input.toolName);
	if (!known || !input.claims.tools.includes(input.toolName)) {
		return { allowed: false, code: 'UNAUTHORIZED', requiresFabricAdmission: false };
	}
	if (input.requiresFabricAdmission && !input.fabricAdmitted) {
		return {
			allowed: false,
			code: 'FABRIC_ADMISSION_DENIED',
			requiresFabricAdmission: true,
		};
	}
	return { allowed: true, requiresFabricAdmission: input.requiresFabricAdmission };
}
