/**
 * Artifact registry on Durable Object SQLite (P22-A3).
 *
 * Metadata and revision CAS live in DO SQL. HTML bytes do not: those go to
 * the content-addressed blob store. Re-opening the same SQL storage restores
 * the registry after eviction.
 */

import type { DurableObjectSqliteStorage } from '../../cloudflare/do-sqlite-database.ts';
import {
	computeCasToken,
	RevisionConflictError,
	type ArtifactRevision,
	type ArtifactRevisionStatus,
} from '../registry.ts';

export class SqliteArtifactRegistry {
	constructor(private readonly storage: DurableObjectSqliteStorage) {
		const sql = storage.sql;
		sql.exec(`CREATE TABLE IF NOT EXISTS p22_artifacts (
			artifact_id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL,
			owner_principal TEXT NOT NULL,
			title TEXT,
			created_at TEXT NOT NULL,
			head_revision_id TEXT,
			revoked INTEGER NOT NULL
		)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS p22_revisions (
			artifact_id TEXT NOT NULL,
			revision_id TEXT NOT NULL,
			parent_revision_id TEXT,
			bundle_digest TEXT NOT NULL,
			ui_resource_uri TEXT NOT NULL,
			cas_token TEXT NOT NULL,
			status TEXT NOT NULL,
			published_at TEXT,
			PRIMARY KEY (artifact_id, revision_id)
		)`);
	}

	createArtifact(input: {
		artifactId: string;
		tenantId: string;
		ownerPrincipal: string;
		title?: string;
	}): void {
		const existing = this.storage.sql
			.exec('SELECT artifact_id FROM p22_artifacts WHERE artifact_id = ?', input.artifactId)
			.toArray();
		if (existing.length > 0) throw new Error(`Artifact '${input.artifactId}' already exists`);
		this.storage.sql.exec(
			`INSERT INTO p22_artifacts
			 (artifact_id, tenant_id, owner_principal, title, created_at, head_revision_id, revoked)
			 VALUES (?, ?, ?, ?, ?, NULL, 0)`,
			input.artifactId,
			input.tenantId,
			input.ownerPrincipal,
			input.title ?? null,
			new Date().toISOString(),
		);
	}

	publishRevision(input: {
		artifactId: string;
		revisionId: string;
		parentRevisionId: string | null;
		bundleDigest: string;
		uiResourceUri: string;
		expectedCasToken?: string;
	}): ArtifactRevision {
		const rows = this.storage.sql
			.exec(
				'SELECT revision_id, bundle_digest, ui_resource_uri, cas_token, status, parent_revision_id, published_at FROM p22_revisions WHERE artifact_id = ? AND revision_id = ?',
				input.artifactId,
				input.revisionId,
			)
			.toArray();
		const existing = rows[0];
		if (existing) {
			if (existing.bundle_digest !== input.bundleDigest) {
				throw new RevisionConflictError(`Revision '${input.revisionId}' digest mismatch`);
			}
			return rowToRevision(existing);
		}
		if (input.expectedCasToken) {
			const head = this.head(input.artifactId);
			if (!head || head.casToken !== input.expectedCasToken) {
				throw new RevisionConflictError('CAS token does not match head revision');
			}
		}
		const casToken = computeCasToken(input.artifactId, input.revisionId, input.bundleDigest);
		const publishedAt = new Date().toISOString();
		const write = () => {
			this.storage.sql.exec(
				`INSERT INTO p22_revisions
				 (artifact_id, revision_id, parent_revision_id, bundle_digest, ui_resource_uri, cas_token, status, published_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'published', ?)`,
				input.artifactId,
				input.revisionId,
				input.parentRevisionId,
				input.bundleDigest,
				input.uiResourceUri,
				casToken,
				publishedAt,
			);
			this.storage.sql.exec(
				'UPDATE p22_artifacts SET head_revision_id = ? WHERE artifact_id = ?',
				input.revisionId,
				input.artifactId,
			);
		};
		if (this.storage.transactionSync) this.storage.transactionSync(write);
		else write();
		return {
			revisionId: input.revisionId,
			parentRevisionId: input.parentRevisionId,
			bundleDigest: input.bundleDigest,
			uiResourceUri: input.uiResourceUri,
			casToken,
			status: 'published',
			publishedAt,
		};
	}

	head(artifactId: string): ArtifactRevision | undefined {
		const artifacts = this.storage.sql
			.exec('SELECT head_revision_id FROM p22_artifacts WHERE artifact_id = ?', artifactId)
			.toArray();
		const headId = artifacts[0]?.head_revision_id;
		if (typeof headId !== 'string') return undefined;
		const rows = this.storage.sql
			.exec(
				'SELECT revision_id, bundle_digest, ui_resource_uri, cas_token, status, parent_revision_id, published_at FROM p22_revisions WHERE artifact_id = ? AND revision_id = ?',
				artifactId,
				headId,
			)
			.toArray();
		const row = rows[0];
		return row ? rowToRevision(row) : undefined;
	}

	revoke(artifactId: string, revisionId: string): void {
		const changed = this.storage.sql.exec(
			`UPDATE p22_revisions SET status = 'revoked' WHERE artifact_id = ? AND revision_id = ?`,
			artifactId,
			revisionId,
		);
		if ((changed.rowsWritten ?? 0) === 0 && changed.toArray().length === 0) {
			const found = this.storage.sql
				.exec(
					'SELECT revision_id FROM p22_revisions WHERE artifact_id = ? AND revision_id = ?',
					artifactId,
					revisionId,
				)
				.toArray();
			if (found.length === 0) throw new Error(`Revision '${revisionId}' not found`);
		}
	}
}

function rowToRevision(row: Record<string, unknown>): ArtifactRevision {
	return {
		revisionId: String(row.revision_id),
		parentRevisionId: row.parent_revision_id == null ? null : String(row.parent_revision_id),
		bundleDigest: String(row.bundle_digest),
		uiResourceUri: String(row.ui_resource_uri),
		casToken: String(row.cas_token),
		status: String(row.status) as ArtifactRevisionStatus,
		...(row.published_at ? { publishedAt: String(row.published_at) } : {}),
	};
}
