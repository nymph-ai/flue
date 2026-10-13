import { describe, expect, it } from 'vitest';
import { FakeDurableObjectStorage } from '../cloudflare/do-sqlite-test-support.ts';
import { publishReviewedHtmlArtifact } from './promotion-publish.ts';
import { ContentAddressedBlobStore, MemoryBlobBucket } from './storage/blob-store.ts';
import { SqliteArtifactRegistry } from './storage/sqlite-registry.ts';

describe('publishReviewedHtmlArtifact', () => {
	it('drafts, publishes, and resolves the same html from a restarted registry', async () => {
		const storage = new FakeDurableObjectStorage();
		const blobs = new ContentAddressedBlobStore(new MemoryBlobBucket());
		const registryA = new SqliteArtifactRegistry(storage);
		const html = '<!doctype html><html><body>scoreboard</body></html>';
		const view = await publishReviewedHtmlArtifact({
			registry: registryA,
			blobs,
			artifactId: 'artifact://tenant-alpha/scoreboard',
			tenantId: 'tenant-alpha',
			ownerPrincipal: 'user:alice',
			revisionId: 'rev_publish_1',
			uiResourceUri: 'ui://tenant-alpha/scoreboard/v1',
			html,
		});
		const registryB = new SqliteArtifactRegistry(storage);
		const head = registryB.head('artifact://tenant-alpha/scoreboard');
		expect(head?.revisionId).toBe(view.revisionId);
		const bytes = await blobs.get(view.bundleDigest);
		expect(Buffer.from(bytes!).toString('utf8')).toBe(view.html);
	});
});
