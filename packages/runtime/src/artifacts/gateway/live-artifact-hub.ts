/**
 * Live artifact hub: registry, producer fence, blobs, and read gateway on one DO.
 */

import type { DurableObjectSqliteStorage } from '../../cloudflare/do-sqlite-database.ts';
import { configuredStreamsLog } from '../../runtime/streams-config.ts';
import type { DurableStreamLog } from '../../streams/log.ts';
import { SqliteProducerFenceStore } from '../publish/sqlite-producer-fence.ts';
import { ContentAddressedBlobStore, type BlobBucket } from '../storage/blob-store.ts';
import { SqliteArtifactRegistry } from '../storage/sqlite-registry.ts';
import { MemoryReadGateway } from './memory-gateway.ts';
import type { ReadGatewayPort } from './read-gateway.ts';
import { RegistryViewerAuthorizationPort } from './registry-viewer-auth.ts';
import { artifactEventStreamId } from './stream-id.ts';

export interface LiveArtifactHubComponents {
	readonly registry: SqliteArtifactRegistry;
	readonly fenceStore: SqliteProducerFenceStore;
	readonly blobs: ContentAddressedBlobStore;
	readonly gateway: ReadGatewayPort;
	readonly streamLog: DurableStreamLog;
}

export function createLiveArtifactHubComponents(input: {
	readonly storage: DurableObjectSqliteStorage;
	readonly env: Record<string, unknown>;
	readonly blobBucket: BlobBucket;
	readonly viewerSecret: string;
}): LiveArtifactHubComponents {
	const registry = new SqliteArtifactRegistry(input.storage);
	const fenceStore = new SqliteProducerFenceStore(input.storage);
	const blobs = new ContentAddressedBlobStore(input.blobBucket);
	const streamLog = configuredStreamsLog(input.env);
	if (!streamLog) {
		throw new Error(
			'[live-artifacts] Electric streams not configured: set FLUE_STREAMS_URL and optional FLUE_STREAMS / FLUE_STREAMS_TOKEN.',
		);
	}
	const authorization = new RegistryViewerAuthorizationPort(registry);
	const gateway = new MemoryReadGateway({
		log: streamLog,
		secret: input.viewerSecret,
		streamFor: (artifactId) => artifactEventStreamId(artifactId),
		authorization,
	});
	return { registry, fenceStore, blobs, gateway, streamLog };
}
