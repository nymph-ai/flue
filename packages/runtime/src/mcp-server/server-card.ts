/**
 * Server Card & Pre-connection Discovery.
 *
 * Generates both the pre-connection Server Card and post-connection server/discover
 * from the same canonical ServerDescriptor.
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
			serverInfo: {
				name: this.descriptor.name,
				version: this.descriptor.version,
				description: this.descriptor.description,
			},
			protocolVersion: this.descriptor.protocolVersion,
			endpoints: this.descriptor.endpoints,
			capabilities: {
				tools: { listChanged: true },
				resources: { subscribe: true, listChanged: true },
				prompts: { listChanged: true },
				logging: {},
			},
			extensions: this.descriptor.extensions,
			profiles: this.descriptor.profiles ?? ['default'],
		};
	}

	/**
	 * Get the post-connection server/discover structure.
	 */
	getServerDiscover(negotiated?: {
		activeProfile?: string;
		activeExtensions?: Record<string, boolean>;
	}): Record<string, unknown> {
		return {
			serverInfo: {
				name: this.descriptor.name,
				version: this.descriptor.version,
				description: this.descriptor.description,
			},
			protocolVersion: this.descriptor.protocolVersion,
			capabilities: {
				tools: { listChanged: true },
				resources: { subscribe: true, listChanged: true },
				prompts: { listChanged: true },
				logging: {},
			},
			extensions: negotiated?.activeExtensions ?? this.descriptor.extensions,
			activeProfile: negotiated?.activeProfile ?? 'default',
			profiles: this.descriptor.profiles ?? ['default'],
			progressiveDiscovery: {
				searchTool: 'flue.search',
				describeTool: 'flue.describe',
				invokeTool: 'flue.invoke',
				resolveTool: 'flue.resolve',
				categoriesTool: 'flue.categories',
			},
		};
	}
}
