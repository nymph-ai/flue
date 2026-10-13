/**
 * Draft → review → publish → durable ui:// (live-artifacts A9).
 */

import { compileHtmlArtifactBundle } from './bundle/compiler.ts';
import type { ContentAddressedBlobStore } from './storage/blob-store.ts';
import type { SqliteArtifactRegistry } from './storage/sqlite-registry.ts';

export interface PublishedArtifactView {
	readonly artifactId: string;
	readonly revisionId: string;
	readonly uiResourceUri: string;
	readonly bundleDigest: string;
	readonly html: string;
}

export async function publishReviewedHtmlArtifact(input: {
	readonly registry: SqliteArtifactRegistry;
	readonly blobs: ContentAddressedBlobStore;
	readonly artifactId: string;
	readonly tenantId: string;
	readonly ownerPrincipal: string;
	readonly revisionId: string;
	readonly uiResourceUri: string;
	readonly html: string;
	readonly expectedCasToken?: string;
}): Promise<PublishedArtifactView> {
	if (!input.registry.head(input.artifactId)) {
		input.registry.createArtifact({
			artifactId: input.artifactId,
			tenantId: input.tenantId,
			ownerPrincipal: input.ownerPrincipal,
		});
	}
	const bundle = compileHtmlArtifactBundle(input.html);
	await input.blobs.put(bundle.digest, Buffer.from(bundle.html));
	const revision = input.registry.publishRevision({
		artifactId: input.artifactId,
		revisionId: input.revisionId,
		parentRevisionId: input.registry.head(input.artifactId)?.revisionId ?? null,
		bundleDigest: bundle.digest,
		uiResourceUri: input.uiResourceUri,
		expectedCasToken: input.expectedCasToken,
	});
	return {
		artifactId: input.artifactId,
		revisionId: revision.revisionId,
		uiResourceUri: input.uiResourceUri,
		bundleDigest: revision.bundleDigest,
		html: bundle.html,
	};
}
