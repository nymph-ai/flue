import { describe, expect, it } from 'vitest';
import { ArtifactRegistry, RevisionConflictError } from './registry.ts';

describe('ArtifactRegistry', () => {
	it('publish is idempotent for the same revision', () => {
		const reg = new ArtifactRegistry();
		reg.createArtifact({
			artifactId: 'artifact://t/a',
			tenantId: 't',
			ownerPrincipal: 'user:u',
		});
		const first = reg.publishRevision({
			artifactId: 'artifact://t/a',
			revisionId: 'rev_1',
			parentRevisionId: null,
			bundleDigest: 'sha256:' + 'a'.repeat(64),
			uiResourceUri: 'ui://a/v1',
		});
		const second = reg.publishRevision({
			artifactId: 'artifact://t/a',
			revisionId: 'rev_1',
			parentRevisionId: null,
			bundleDigest: 'sha256:' + 'a'.repeat(64),
			uiResourceUri: 'ui://a/v1',
		});
		expect(second.casToken).toBe(first.casToken);
	});

	it('CAS mismatch fails', () => {
		const reg = new ArtifactRegistry();
		reg.createArtifact({
			artifactId: 'artifact://t/a',
			tenantId: 't',
			ownerPrincipal: 'user:u',
		});
		const head = reg.publishRevision({
			artifactId: 'artifact://t/a',
			revisionId: 'rev_1',
			parentRevisionId: null,
			bundleDigest: 'sha256:' + 'a'.repeat(64),
			uiResourceUri: 'ui://a/v1',
		});
		expect(() =>
			reg.publishRevision({
				artifactId: 'artifact://t/a',
				revisionId: 'rev_2',
				parentRevisionId: 'rev_1',
				bundleDigest: 'sha256:' + 'b'.repeat(64),
				uiResourceUri: 'ui://a/v2',
				expectedCasToken: 'wrong',
			}),
		).toThrow(RevisionConflictError);
		expect(head.casToken).toMatch(/^cas:/);
	});
});
