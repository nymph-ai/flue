/**
 * Authoring helpers for the artifact SDK (live-artifacts A15).
 * Agents call these with declared capabilities. No ambient privilege.
 */

import { ArtifactRegistry, digestBundle } from '../registry.ts';
import { promoteEphemeralHtml } from '../promotion.ts';

export function authorAndStage(input: {
	readonly registry: ArtifactRegistry;
	readonly artifactId: string;
	readonly tenantId: string;
	readonly ownerPrincipal: string;
	readonly html: string;
	readonly revisionId: string;
	readonly uiResourceUri: string;
}): {
	readonly digest: string;
	readonly reviewRequired: true;
	readonly revisionId: string;
	readonly uiResourceUri: string;
} {
	input.registry.createArtifact({
		artifactId: input.artifactId,
		tenantId: input.tenantId,
		ownerPrincipal: input.ownerPrincipal,
	});
	const draft = promoteEphemeralHtml({
		artifactId: input.artifactId,
		tenantId: input.tenantId,
		html: input.html,
	});
	if (draft.bundle.digest !== digestBundle(input.html)) {
		throw new Error('bundle digest drifted from source html');
	}
	return {
		digest: draft.bundle.digest,
		reviewRequired: true,
		revisionId: input.revisionId,
		uiResourceUri: input.uiResourceUri,
	};
}
