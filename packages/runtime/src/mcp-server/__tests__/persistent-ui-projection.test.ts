import { describe, expect, it } from 'vitest';
import { FakeDurableObjectStorage } from '../../cloudflare/do-sqlite-test-support.ts';
import { RegistryBackedUiResourceReader } from '../../artifacts/persistent-ui-resources.ts';
import { digestBundle } from '../../artifacts/registry.ts';
import { ContentAddressedBlobStore, MemoryBlobBucket } from '../../artifacts/storage/blob-store.ts';
import { SqliteArtifactRegistry } from '../../artifacts/storage/sqlite-registry.ts';
import { McpCapabilityProjection } from '../projection.ts';

describe('McpCapabilityProjection durable ui:// reads', () => {
	it('loads published ui:// resources from the registry rather than AppManager', async () => {
		const storage = new FakeDurableObjectStorage();
		const registry = new SqliteArtifactRegistry(storage);
		const blobs = new ContentAddressedBlobStore(new MemoryBlobBucket());
		const html = '<!doctype html><html><body>durable</body></html>';
		const digest = digestBundle(html);
		await blobs.put(digest, Buffer.from(html));
		registry.createArtifact({
			artifactId: 'artifact://tenant/a',
			tenantId: 'tenant',
			ownerPrincipal: 'user:alice',
		});
		registry.publishRevision({
			artifactId: 'artifact://tenant/a',
			revisionId: 'rev_1',
			parentRevisionId: null,
			bundleDigest: digest,
			uiResourceUri: 'ui://tenant/a/v1',
		});
		const projection = new McpCapabilityProjection({
			uiResourceReader: new RegistryBackedUiResourceReader(registry, blobs),
		});
		const res = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'resources/read',
			params: {
				uri: 'ui://tenant/a/v1',
				_meta: {
					'io.modelcontextprotocol/clientCapabilities': {
						extensions: { 'io.modelcontextprotocol/ui': true },
					},
				},
			},
		})) as any;
		expect(res.result.contents[0].text).toContain('durable');
	});
});
