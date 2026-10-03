/**
 * Server Card & Pre-connection Discovery.
 *
 * Generates both the pre-connection Server Card and post-connection server/discover
 * from the same canonical ServerDescriptor.
 *
 * Follows MCP 2026-07-28 DiscoverResult contract:
 * - resultType: "complete"
 * - supportedVersions: ["2026-07-28", "2024-11-05"]
 * - serverInfo and _meta metadata
 *
 * Reference: docs/mcp-capability-projection.md § 11
 */

import type { ServerDescriptor } from './types.ts';

export class ServerCardManager {
	constructor(private readonly descriptor: ServerDescriptor) {}

	/**
	 * Get the static pre-connection Server Card JSON structure.
	 */
	getServerCard(): Record<string, unknown> {
		return {
			$schema: 'https://modelcontextprotocol.io/schemas/server-card.json',
			name: this.descriptor.name,
			version: this.descriptor.version,
			description: this.descriptor.description,
			serverInfo: {
				name: this.descriptor.name,
				version: this.descriptor.version,
				description: this.descriptor.description,
			},
			protocolVersion: this.descriptor.protocolVersion,
			endpoints: this.descriptor.endpoints,
			capabilities: {
				tools: { listChanged: false },
				resources: { subscribe: true, listChanged: false },
				prompts: { listChanged: false },
				logging: {},
				events: { subscribe: true, list: true, history: true },
			},
			extensions: this.descriptor.extensions,
			profiles: this.descriptor.profiles ?? ['default'],
		};
	}

	/**
	 * Alias for getServerCard to support generator naming conventions.
	 */
	generateServerCard(): Record<string, unknown> {
		return this.getServerCard();
	}

	/**
	 * Get the post-connection server/discover structure (MCP 2026-07-28).
	 */
	getServerDiscover(negotiated?: {
		activeProfile?: string;
		activeExtensions?: Record<string, boolean>;
		tools?: Array<Record<string, unknown>>;
		events?: Array<Record<string, unknown>>;
	}): Record<string, unknown> {
		return {
			resultType: 'complete',
			protocolVersion: this.descriptor.protocolVersion,
			supportedVersions: [this.descriptor.protocolVersion, '2024-11-05'],
			serverInfo: {
				name: this.descriptor.name,
				version: this.descriptor.version,
				description: this.descriptor.description,
			},
			_meta: {
				name: this.descriptor.name,
				version: this.descriptor.version,
				description: this.descriptor.description,
			},
			capabilities: {
				tools: { listChanged: false },
				resources: { subscribe: true, listChanged: false },
				prompts: { listChanged: false },
				logging: {},
				events: { subscribe: true, list: true, history: true },
			},
			extensions: this.descriptor.extensions,
			activeExtensions: negotiated?.activeExtensions,
			activeProfile: negotiated?.activeProfile ?? 'default',
			profiles: this.descriptor.profiles ?? ['default'],
			progressiveDiscovery: {
				searchTool: 'flue.search',
				describeTool: 'flue.describe',
				invokeTool: 'flue.invoke',
				resolveTool: 'flue.resolve',
				categoriesTool: 'flue.categories',
			},
			...(negotiated?.tools ? { tools: negotiated.tools } : {}),
			...(negotiated?.events ? { events: negotiated.events } : {}),
		};
	}
}
