/**
 * Read-gateway authorization backed by the DO artifact registry (live-artifacts).
 */

import type { ViewerClaims } from '../auth/tokens.ts';
import type { SqliteArtifactRegistry } from '../storage/sqlite-registry.ts';
import type { ViewerAuthorizationPort } from './viewer-auth.ts';

export class RegistryViewerAuthorizationPort implements ViewerAuthorizationPort {
	constructor(private readonly registry: SqliteArtifactRegistry) {}

	isArtifactRevoked(artifactId: string): boolean {
		if (this.registry.isArtifactRevoked(artifactId)) return true;
		const head = this.registry.head(artifactId);
		return head?.status === 'revoked';
	}

	principalAllowed(_claims: ViewerClaims): boolean {
		return true;
	}
}
