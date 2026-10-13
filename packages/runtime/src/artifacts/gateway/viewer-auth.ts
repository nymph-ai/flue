/**
 * Authoritative viewer checks for the read gateway (live-artifacts A7).
 */

import type { ViewerClaims } from '../auth/tokens.ts';

export interface ViewerAuthorizationPort {
	isArtifactRevoked(artifactId: string): boolean;
	principalAllowed(claims: ViewerClaims): boolean;
}

export class MemoryViewerAuthorizationPort implements ViewerAuthorizationPort {
	private readonly revoked = new Set<string>();
	private readonly deniedPrincipals = new Set<string>();

	revoke(artifactId: string): void {
		this.revoked.add(artifactId);
	}

	denyPrincipal(principal: string): void {
		this.deniedPrincipals.add(principal);
	}

	isArtifactRevoked(artifactId: string): boolean {
		return this.revoked.has(artifactId);
	}

	principalAllowed(claims: ViewerClaims): boolean {
		return !this.deniedPrincipals.has(claims.principal);
	}
}
