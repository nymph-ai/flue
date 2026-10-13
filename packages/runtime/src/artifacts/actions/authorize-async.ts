/**
 * Async artifact action authorization (P22-A7).
 */

import type { ViewerClaims } from '../auth/tokens.ts';
import { verifyFabricAdmission, type FabricAdmissionVerifier } from './fabric-admission.ts';
import type { AuthorizeDecision } from './authorize.ts';
import { authorizeArtifactAction, type AuthorizeInput } from './authorize.ts';

export interface AuthorizeContext {
	readonly claims: ViewerClaims | null;
	readonly artifactId: string;
	readonly tenantId: string;
	readonly toolName: string;
	readonly appOnlyTools: readonly string[];
	readonly allowedTools: readonly string[];
	readonly revoked: boolean;
	readonly requiresFabricAdmission: boolean;
	readonly fabricAdmission?: FabricAdmissionVerifier;
}

export async function authorizeArtifactActionAsync(
	ctx: AuthorizeContext,
): Promise<AuthorizeDecision> {
	const base = authorizeArtifactAction({
		claims: ctx.claims,
		artifactId: ctx.artifactId,
		tenantId: ctx.tenantId,
		toolName: ctx.toolName,
		appOnlyTools: ctx.appOnlyTools,
		allowedTools: ctx.allowedTools,
		revoked: ctx.revoked,
		requiresFabricAdmission: ctx.requiresFabricAdmission,
		fabricAdmitted: false,
	});
	if (!base.allowed && base.code !== 'FABRIC_ADMISSION_DENIED') {
		return base;
	}
	if (!ctx.requiresFabricAdmission) {
		return base;
	}
	if (!ctx.claims) {
		return { allowed: false, code: 'UNAUTHORIZED', requiresFabricAdmission: true };
	}
	const admitted = await verifyFabricAdmission(ctx.fabricAdmission, {
		artifactId: ctx.artifactId,
		tenantId: ctx.tenantId,
		toolName: ctx.toolName,
		principal: ctx.claims.principal,
	});
	if (!admitted) {
		return { allowed: false, code: 'FABRIC_ADMISSION_DENIED', requiresFabricAdmission: true };
	}
	return authorizeArtifactAction({
		claims: ctx.claims,
		artifactId: ctx.artifactId,
		tenantId: ctx.tenantId,
		toolName: ctx.toolName,
		appOnlyTools: ctx.appOnlyTools,
		allowedTools: ctx.allowedTools,
		revoked: ctx.revoked,
		requiresFabricAdmission: true,
		fabricAdmitted: true,
	});
}

export function toSyncInput(ctx: AuthorizeContext, fabricAdmitted: boolean): AuthorizeInput {
	return {
		claims: ctx.claims,
		artifactId: ctx.artifactId,
		tenantId: ctx.tenantId,
		toolName: ctx.toolName,
		appOnlyTools: ctx.appOnlyTools,
		allowedTools: ctx.allowedTools,
		revoked: ctx.revoked,
		requiresFabricAdmission: ctx.requiresFabricAdmission,
		fabricAdmitted,
	};
}
