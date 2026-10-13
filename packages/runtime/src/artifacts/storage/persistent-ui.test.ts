import { describe, expect, it } from 'vitest';
import { FakeDurableObjectStorage } from '../../cloudflare/do-sqlite-test-support.ts';
import { RegistryBackedUiResourceReader, UiResourceRevokedError } from '../persistent-ui-resources.ts';
import { digestBundle } from '../registry.ts';
import { ContentAddressedBlobStore, MemoryBlobBucket } from './blob-store.ts';
import { SqliteArtifactRegistry } from './sqlite-registry.ts';

describe('RegistryBackedUiResourceReader', () => {
	it('serves ui:// bytes from durable registry after a new reader opens storage', async () => {
		const storage = new FakeDurableObjectStorage();
		const registry = new SqliteArtifactRegistry(storage);
		const blobs = new ContentAddressedBlobStore(new MemoryBlobBucket());
		const html = '<!doctype html><html><body>persisted</body></html>';
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

		const reader = new RegistryBackedUiResourceReader(
			new SqliteArtifactRegistry(storage),
			blobs,
		);
		const res = await reader.readUiResource('ui://tenant/a/v1');
		expect(res.content).toContain('persisted');
		expect(res.mimeType).toContain('mcp-app');
	});

	it('refuses revoked head revisions', async () => {
		const storage = new FakeDurableObjectStorage();
		const registry = new SqliteArtifactRegistry(storage);
		const blobs = new ContentAddressedBlobStore(new MemoryBlobBucket());
		const html = '<!doctype html><html><body>x</body></html>';
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
		registry.revoke('artifact://tenant/a', 'rev_1');
		const reader = new RegistryBackedUiResourceReader(registry, blobs);
		await expect(reader.readUiResource('ui://tenant/a/v1')).rejects.toBeInstanceOf(UiResourceRevokedError);
	});
});
