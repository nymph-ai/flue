import { describe, expect, it } from 'vitest';
import { FakeDurableObjectStorage } from '../../cloudflare/do-sqlite-test-support.ts';
import { digestBundle } from '../registry.ts';
import { ContentAddressedBlobStore, ImmutableBlobConflict, MemoryBlobBucket } from './blob-store.ts';
import { SqliteArtifactRegistry } from './sqlite-registry.ts';

const DIGEST = 'sha256:' + 'ab'.repeat(32);

describe('SqliteArtifactRegistry', () => {
	it('survives a new registry opened on the same DO sqlite', () => {
		const storage = new FakeDurableObjectStorage();
		const first = new SqliteArtifactRegistry(storage);
		first.createArtifact({
			artifactId: 'artifact://t/a',
			tenantId: 't',
			ownerPrincipal: 'user:a',
		});
		const published = first.publishRevision({
			artifactId: 'artifact://t/a',
			revisionId: 'rev_1',
			parentRevisionId: null,
			bundleDigest: DIGEST,
			uiResourceUri: 'ui://a/v1',
		});
		const reopened = new SqliteArtifactRegistry(storage);
		expect(reopened.head('artifact://t/a')?.casToken).toBe(published.casToken);
		expect(reopened.head('artifact://t/a')?.bundleDigest).toBe(DIGEST);
	});
});

describe('ContentAddressedBlobStore', () => {
	it('rejects a different body for the same digest and replays the same body', async () => {
		const store = new ContentAddressedBlobStore(new MemoryBlobBucket());
		const html = '<!doctype html><html><body>ok</body></html>';
		const digest = digestBundle(html);
		await store.put(digest, Buffer.from(html));
		await store.put(digest, Buffer.from(html));
		await expect(store.put(digest, Buffer.from(html + 'x'))).rejects.toBeInstanceOf(ImmutableBlobConflict);
		const got = await store.get(digest);
		expect(Buffer.from(got!).toString('utf8')).toBe(html);
	});
});
