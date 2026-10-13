/**
 * Persistent artifact registry (live-artifacts A3).
 *
 * Stable artifact:// identities, content-addressed bundle digests, revision CAS,
 * and publish/revoke lifecycle. HTML bodies live in bundle storage — never Electric.
 */

import { createHash } from 'node:crypto';

export type ArtifactRevisionStatus = 'draft' | 'published' | 'revoked' | 'retired';

export interface ArtifactRevision {
	revisionId: string;
	parentRevisionId: string | null;
	bundleDigest: string;
	uiResourceUri: string;
	casToken: string;
	status: ArtifactRevisionStatus;
	publishedAt?: string;
}

export interface ArtifactRecord {
	artifactId: string;
	tenantId: string;
	ownerPrincipal: string;
	title?: string;
	createdAt: string;
	headRevisionId: string | null;
	revisions: Map<string, ArtifactRevision>;
}

export class RevisionConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RevisionConflictError';
	}
}

export class ArtifactRegistry {
	private readonly artifacts = new Map<string, ArtifactRecord>();

	createArtifact(input: {
		artifactId: string;
		tenantId: string;
		ownerPrincipal: string;
		title?: string;
	}): ArtifactRecord {
		if (this.artifacts.has(input.artifactId)) {
			throw new Error(`Artifact '${input.artifactId}' already exists`);
		}
		const record: ArtifactRecord = {
			...input,
			createdAt: new Date().toISOString(),
			headRevisionId: null,
			revisions: new Map(),
		};
		this.artifacts.set(input.artifactId, record);
		return record;
	}

	get(artifactId: string): ArtifactRecord | undefined {
		return this.artifacts.get(artifactId);
	}

	/** Idempotent when the same revisionId + bundleDigest is replayed. */
	publishRevision(input: {
		artifactId: string;
		revisionId: string;
		parentRevisionId: string | null;
		bundleDigest: string;
		uiResourceUri: string;
		expectedCasToken?: string;
	}): ArtifactRevision {
		const record = this.artifacts.get(input.artifactId);
		if (!record) throw new Error(`Artifact '${input.artifactId}' not found`);

		const existing = record.revisions.get(input.revisionId);
		if (existing) {
			if (existing.bundleDigest !== input.bundleDigest) {
				throw new RevisionConflictError(`Revision '${input.revisionId}' digest mismatch`);
			}
			return existing;
		}

		if (input.expectedCasToken && record.headRevisionId) {
			const head = record.revisions.get(record.headRevisionId);
			if (!head || head.casToken !== input.expectedCasToken) {
				throw new RevisionConflictError('CAS token does not match head revision');
			}
		}

		const casToken = computeCasToken(input.artifactId, input.revisionId, input.bundleDigest);
		const revision: ArtifactRevision = {
			revisionId: input.revisionId,
			parentRevisionId: input.parentRevisionId,
			bundleDigest: input.bundleDigest,
			uiResourceUri: input.uiResourceUri,
			casToken,
			status: 'published',
			publishedAt: new Date().toISOString(),
		};
		record.revisions.set(input.revisionId, revision);
		record.headRevisionId = input.revisionId;
		return revision;
	}

	revoke(artifactId: string, revisionId: string): void {
		const record = this.artifacts.get(artifactId);
		if (!record) throw new Error(`Artifact '${artifactId}' not found`);
		const rev = record.revisions.get(revisionId);
		if (!rev) throw new Error(`Revision '${revisionId}' not found`);
		rev.status = 'revoked';
	}
}

export function computeCasToken(artifactId: string, revisionId: string, bundleDigest: string): string {
	const h = createHash('sha256');
	h.update(`${artifactId}\0${revisionId}\0${bundleDigest}`);
	return `cas:${h.digest('hex').slice(0, 32)}`;
}

export function digestBundle(bytes: Uint8Array | string): string {
	const h = createHash('sha256');
	h.update(typeof bytes === 'string' ? bytes : bytes);
	return `sha256:${h.digest('hex')}`;
}
