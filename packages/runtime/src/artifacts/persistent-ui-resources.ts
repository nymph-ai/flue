/**
 * Durable ui:// resolution (live-artifacts A2 / A3).
 *
 * MCP resources/read loads immutable bundle bytes from the artifact registry
 * and blob store. Process-local AppManager registrations remain a dev fallback.
 */

import type { McpUiResourceMeta } from '../mcp-server/types.ts';
import { MCP_APP_HTML_MIME } from '../mcp-server/types.ts';
import { digestBundle } from './registry.ts';
import type { ContentAddressedBlobStore } from './storage/blob-store.ts';
import type { SqliteArtifactRegistry } from './storage/sqlite-registry.ts';

export class UiResourceRevokedError extends Error {
	constructor(uri: string) {
		super(`UI resource '${uri}' is revoked`);
		this.name = 'UiResourceRevokedError';
	}
}

export class UiResourceNotFoundError extends Error {
	constructor(uri: string) {
		super(`UI View '${uri}' not found.`);
		this.name = 'UiResourceNotFoundError';
	}
}

export interface PersistentUiResourceReader {
	readUiResource(uri: string): Promise<{
		content: string;
		mimeType: string;
		_meta: { ui: McpUiResourceMeta };
	}>;
}

export class RegistryBackedUiResourceReader implements PersistentUiResourceReader {
	constructor(
		private readonly registry: SqliteArtifactRegistry,
		private readonly blobs: ContentAddressedBlobStore,
		private readonly metaFor?: (uri: string) => McpUiResourceMeta | undefined,
	) {}

	async readUiResource(uri: string): Promise<{
		content: string;
		mimeType: string;
		_meta: { ui: McpUiResourceMeta };
	}> {
		const row = this.registry.resolvePublishedUiResource(uri);
		if (!row) throw new UiResourceNotFoundError(uri);
		if (row.status === 'revoked') throw new UiResourceRevokedError(uri);
		const bytes = await this.blobs.get(row.bundleDigest);
		if (!bytes) throw new UiResourceNotFoundError(uri);
		const html = Buffer.from(bytes).toString('utf8');
		const computed = digestBundle(html);
		if (computed !== row.bundleDigest) {
			throw new Error(`bundle digest mismatch for ${uri}`);
		}
		return {
			content: html,
			mimeType: MCP_APP_HTML_MIME,
			_meta: { ui: this.metaFor?.(uri) ?? {} },
		};
	}
}
