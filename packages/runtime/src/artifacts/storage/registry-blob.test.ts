import { describe, expect, it } from 'vitest';
import { FakeDurableObjectStorage } from '../../cloudflare/do-sqlite-test-support.ts';
import { digestBundle } from '../registry.ts';
import {
	BlobDigestMismatch,
	ContentAddressedBlobStore,
	ImmutableBlobConflict,
	MemoryBlobBucket,
	sha256Digest,
} from './blob-store.ts';
import { RevisionConflictError } from '../registry.ts';
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
		await expect(store.put(digest, Buffer.from(html + 'x'))).rejects.toBeInstanceOf(BlobDigestMismatch);
		const got = await store.get(digest);
		expect(Buffer.from(got!).toString('utf8')).toBe(html);
	});

	it('rejects a mismatched digest label on put', async () => {
		const store = new ContentAddressedBlobStore(new MemoryBlobBucket());
		const bytes = Buffer.from('hello');
		await expect(store.put('sha256:' + '00'.repeat(32), bytes)).rejects.toBeInstanceOf(BlobDigestMismatch);
		expect(sha256Digest(bytes)).toMatch(/^sha256:/);
	});
});

describe('SqliteArtifactRegistry CAS', () => {
	it('requires expectedCasToken when a head revision already exists', () => {
		const storage = new FakeDurableObjectStorage();
		const registry = new SqliteArtifactRegistry(storage);
		registry.createArtifact({
			artifactId: 'artifact://t/a',
			tenantId: 't',
			ownerPrincipal: 'user:a',
		});
		const first = registry.publishRevision({
			artifactId: 'artifact://t/a',
			revisionId: 'rev_1',
			parentRevisionId: null,
			bundleDigest: DIGEST,
			uiResourceUri: 'ui://a/v1',
		});
		expect(() =>
			registry.publishRevision({
				artifactId: 'artifact://t/a',
				revisionId: 'rev_2',
				parentRevisionId: 'rev_1',
				bundleDigest: DIGEST,
				uiResourceUri: 'ui://a/v2',
			}),
		).toThrow(RevisionConflictError);
		const second = registry.publishRevision({
			artifactId: 'artifact://t/a',
			revisionId: 'rev_2',
			parentRevisionId: 'rev_1',
			bundleDigest: DIGEST,
			uiResourceUri: 'ui://a/v2',
			expectedCasToken: first.casToken,
		});
		expect(second.revisionId).toBe('rev_2');
	});
});
