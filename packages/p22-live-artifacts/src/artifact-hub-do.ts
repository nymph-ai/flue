/**
 * Durable Object hub: artifact registry, producer fence, R2 blobs, read gateway.
 */

import { DurableObject } from 'cloudflare:workers';
import { createP22HubComponents } from '../../runtime/src/artifacts/gateway/p22-hub.ts';
import { createArtifactGateway } from '../../runtime/src/artifacts/gateway/worker.ts';
import { R2BlobBucket } from '../../runtime/src/artifacts/storage/r2-blob-bucket.ts';

export class P22ArtifactHub extends DurableObject<Env> {
	#components?: ReturnType<typeof createP22HubComponents>;

	components(): ReturnType<typeof createP22HubComponents> {
		this.#components ??= createP22HubComponents({
			storage: this.ctx.storage,
			env: this.env as unknown as Record<string, unknown>,
			blobBucket: new R2BlobBucket(this.env.ARTIFACT_BLOBS),
			viewerSecret: this.env.P22_VIEWER_TOKEN_SECRET,
		});
		return this.#components;
	}

	async fetch(request: Request): Promise<Response> {
		const hub = this.components();
		const handler = createArtifactGateway({
			secret: this.env.P22_VIEWER_TOKEN_SECRET,
			gateway: hub.gateway,
		});
		return handler.fetch(request);
	}
}
