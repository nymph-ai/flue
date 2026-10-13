/**
 * Durable Object hub: artifact registry, producer fence, R2 blobs, read gateway.
 */

import { DurableObject } from 'cloudflare:workers';
import { createLiveArtifactHubComponents } from '../../runtime/src/artifacts/gateway/live-artifact-hub.ts';
import { createArtifactGateway } from '../../runtime/src/artifacts/gateway/worker.ts';
import { R2BlobBucket } from '../../runtime/src/artifacts/storage/r2-blob-bucket.ts';

export class LiveArtifactHub extends DurableObject<Env> {
	#components?: ReturnType<typeof createLiveArtifactHubComponents>;

	components(): ReturnType<typeof createLiveArtifactHubComponents> {
		this.#components ??= createLiveArtifactHubComponents({
			storage: this.ctx.storage,
			env: this.env as unknown as Record<string, unknown>,
			blobBucket: new R2BlobBucket(this.env.ARTIFACT_BLOBS),
			viewerSecret: this.env.LIVE_ARTIFACTS_VIEWER_TOKEN_SECRET,
		});
		return this.#components;
	}

	async fetch(request: Request): Promise<Response> {
		const hub = this.components();
		const handler = createArtifactGateway({
			secret: this.env.LIVE_ARTIFACTS_VIEWER_TOKEN_SECRET,
			gateway: hub.gateway,
		});
		return handler.fetch(request);
	}
}
