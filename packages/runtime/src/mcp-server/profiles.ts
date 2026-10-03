/**
 * Projection Profiles for Flue MCP Capability Projection.
 *
 * Implements SEP-2053-style variant selection mapped to internal ProjectionProfiles.
 *
 * INVARIANT: Never infer profile or capability support from client product name (clientInfo.name).
 * Client selection must be explicit via capabilities, headers, or query parameters.
 *
 * Reference: docs/mcp-capability-projection.md § 12
 */

import type { Capability, ProjectionProfile } from './types.ts';

export const BUILTIN_PROFILES: Record<string, ProjectionProfile> = {
	default: {
		id: 'default',
		name: 'Default Balanced Profile',
		description: 'Standard Flue capability projection with canonical tools and discovery surface.',
		verbosity: 'normal',
	},
	compact: {
		id: 'compact',
		name: 'Compact Profile',
		description: 'Minimal token overhead profile with concise tool descriptions.',
		verbosity: 'minimal',
		toolFilter: (cap: Capability) => {
			// In compact mode, prefer tools with explicitly configured compact variants or core bootstrap
			return cap.category !== 'deprecated';
		},
	},
	research: {
		id: 'research',
		name: 'Research Profile',
		description: 'Profile prioritizing knowledge vault exploration, synthesis, and search.',
		verbosity: 'verbose',
		toolFilter: (cap: Capability) => {
			if (cap.id.startsWith('flue.')) return true;
			return cap.category === 'research' || cap.category === 'knowledge' || cap.kind === 'resource';
		},
		preferredSkills: ['research-synthesis', 'knowledge-vault'],
	},
	coding: {
		id: 'coding',
		name: 'Coding & Engineering Profile',
		description: 'Profile prioritizing code generation, inspection, git operations, and testing.',
		verbosity: 'normal',
		toolFilter: (cap: Capability) => {
			if (cap.id.startsWith('flue.')) return true;
			return cap.category === 'engineering' || cap.category === 'git' || cap.category === 'code';
		},
		preferredSkills: ['git-workflow', 'code-review'],
	},
	chatgpt: {
		id: 'chatgpt',
		name: 'ChatGPT / OpenAI Dots Profile',
		description: 'Optimized for OpenAI Dots with strict schema fidelity and concise descriptions.',
		verbosity: 'normal',
	},
	pi: {
		id: 'pi',
		name: 'Pi Cognitive Agent Profile',
		description: 'Tailored for Pi Core and Chord runtime orchestrations.',
		verbosity: 'normal',
	},
};

export class ProfileResolver {
	private readonly profiles = new Map<string, ProjectionProfile>();

	constructor(customProfiles: ProjectionProfile[] = []) {
		for (const [id, profile] of Object.entries(BUILTIN_PROFILES)) {
			this.profiles.set(id, profile);
		}
		for (const profile of customProfiles) {
			this.profiles.set(profile.id, profile);
		}
	}

	/**
	 * Register or override a projection profile.
	 */
	registerProfile(profile: ProjectionProfile): void {
		this.profiles.set(profile.id, profile);
	}

	/**
	 * Resolve projection profile from request parameters, headers, or query parameters.
	 *
	 * Precedence:
	 * 1. Explicit negotiation (params.variant or clientCapabilities.variant)
	 * 2. HTTP Header: X-MCP-Profile or X-MCP-Variant
	 * 3. Query string: ?profile=... or ?variant=...
	 * 4. Fallback to 'default'
	 *
	 * NOTE: clientInfo.name is NEVER used to select a profile.
	 */
	resolve(options: {
		requestedVariant?: string;
		headers?: Headers | Record<string, string>;
		queryProfile?: string;
	}): ProjectionProfile {
		let chosenId: string | undefined;

		if (options.requestedVariant && this.profiles.has(options.requestedVariant)) {
			chosenId = options.requestedVariant;
		}

		if (!chosenId && options.headers) {
			const getHeader = (name: string): string | null => {
				if (options.headers instanceof Headers) {
					return options.headers.get(name);
				}
				const rec = options.headers as Record<string, string>;
				return rec[name] ?? rec[name.toLowerCase()] ?? null;
			};

			const hdr = getHeader('x-mcp-profile') ?? getHeader('x-mcp-variant');
			if (hdr && this.profiles.has(hdr)) {
				chosenId = hdr;
			}
		}

		if (!chosenId && options.queryProfile && this.profiles.has(options.queryProfile)) {
			chosenId = options.queryProfile;
		}

		return this.profiles.get(chosenId ?? 'default') ?? BUILTIN_PROFILES.default!;
	}

	/**
	 * Get description for a capability under the given profile, checking for variant overrides.
	 */
	getCapabilityDescription(cap: Capability, profile: ProjectionProfile): string {
		// 1. Profile-level explicit override
		if (profile.descriptionOverrides?.[cap.id]) {
			return profile.descriptionOverrides[cap.id]!;
		}

		// 2. Capability variant override matching profile ID
		if (cap.variants?.[profile.id]?.description) {
			return cap.variants[profile.id]!.description!;
		}

		// 3. Compact mode fallback if minimal verbosity
		if (profile.verbosity === 'minimal' && cap.variants?.compact?.description) {
			return cap.variants.compact.description;
		}

		return cap.description;
	}

	listProfiles(): ProjectionProfile[] {
		return Array.from(this.profiles.values());
	}
}
