/**
 * Canonical CapabilityRegistry for Flue.
 *
 * Flue normalizes all exposed functionality into a registry entry with stable identity
 * and sufficient metadata to project into core MCP 2026-07-28 and extensions.
 *
 * Reference: docs/mcp-capability-projection.md § 3
 */

import type {
	Capability,
	CapabilityKind,
	CapabilityResource,
	CapabilitySkill,
} from './types.ts';

export interface ResourceTemplateDescriptor {
	uriTemplate: string;
	name: string;
	description: string;
	mimeType?: string;
}

export class CapabilityRegistry {
	private readonly capabilities = new Map<string, Capability>();
	private readonly extraResources = new Map<string, CapabilityResource>();
	private readonly extraSkills = new Map<string, CapabilitySkill>();

	/**
	 * Canonical resource templates supported by Flue.
	 */
	public static readonly CANONICAL_RESOURCE_TEMPLATES: ResourceTemplateDescriptor[] = [
		{
			uriTemplate: 'capability://{id}',
			name: 'Capability Descriptor',
			description: 'Metadata descriptor, input/output schemas, and effects for a capability.',
			mimeType: 'application/json',
		},
		{
			uriTemplate: 'category://{name}',
			name: 'Capability Category',
			description: 'List of capability descriptors categorized under the specified domain.',
			mimeType: 'application/json',
		},
		{
			uriTemplate: 'skill://{skill}/{path}',
			name: 'Skill Document or Script',
			description: 'Obsidian markdown, shell script, or reference document belonging to a skill package.',
			mimeType: 'text/markdown',
		},
		{
			uriTemplate: 'job://{jobId}',
			name: 'Durable Operation Handle',
			description: 'Current status, progress, and result payload of an asynchronous operation.',
			mimeType: 'application/json',
		},
		{
			uriTemplate: 'eventstream://{streamId}/head',
			name: 'Electric Stream Head Pointer',
			description: 'Current head offset and stream descriptor for a durable Electric stream.',
			mimeType: 'application/json',
		},
		{
			uriTemplate: 'eventstream://{streamId}/after/{cursor}',
			name: 'Electric Stream Events Slice',
			description: 'Events emitted on the stream after the specified opaque cursor.',
			mimeType: 'application/json',
		},
		{
			uriTemplate: 'ui://{app}/{view}',
			name: 'App View Definition',
			description: 'Interactive UI presentation definition for an App-enabled tool.',
			mimeType: 'text/html',
		},
	];

	/**
	 * Register a canonical capability. Throws if ID is already registered.
	 */
	register(capability: Capability): void {
		if (this.capabilities.has(capability.id)) {
			throw new Error(`Capability with id '${capability.id}' is already registered.`);
		}
		this.capabilities.set(capability.id, capability);
	}

	/**
	 * Bulk register capabilities.
	 */
	registerAll(capabilities: Capability[]): void {
		for (const cap of capabilities) {
			this.register(cap);
		}
	}

	/**
	 * Retrieve capability by stable identity.
	 */
	get(id: string): Capability | undefined {
		return this.capabilities.get(id);
	}

	/**
	 * Check whether capability ID exists.
	 */
	has(id: string): boolean {
		return this.capabilities.has(id);
	}

	/**
	 * List registered capabilities with optional kind and category filters.
	 */
	list(filter?: { kind?: CapabilityKind; category?: string }): Capability[] {
		const result: Capability[] = [];
		for (const cap of this.capabilities.values()) {
			if (filter?.kind && cap.kind !== filter.kind) continue;
			if (filter?.category && cap.category !== filter.category) continue;
			result.push(cap);
		}
		return result.sort((a, b) => a.id.localeCompare(b.id));
	}

	/**
	 * Return distinct list of capability categories.
	 */
	getCategories(): string[] {
		const categories = new Set<string>();
		for (const cap of this.capabilities.values()) {
			if (cap.category) categories.add(cap.category);
		}
		return Array.from(categories).sort();
	}

	/**
	 * Register an explicit standalone resource not bound to a capability.
	 */
	registerResource(resource: CapabilityResource): void {
		this.extraResources.set(resource.uri, resource);
	}

	/**
	 * Register an explicit standalone skill.
	 */
	registerSkill(skill: CapabilitySkill): void {
		this.extraSkills.set(skill.name, skill);
	}

	/**
	 * Collect all resources from capabilities and registered extras.
	 */
	getAllResources(): CapabilityResource[] {
		const resources = new Map<string, CapabilityResource>();
		// Standalone resources
		for (const [uri, res] of this.extraResources.entries()) {
			resources.set(uri, res);
		}
		// Capability-attached resources
		for (const cap of this.capabilities.values()) {
			if (cap.resources) {
				for (const res of cap.resources) {
					resources.set(res.uri, res);
				}
			}
		}
		return Array.from(resources.values()).sort((a, b) => a.uri.localeCompare(b.uri));
	}

	/**
	 * Collect all skills from capabilities and registered extras.
	 */
	getAllSkills(): CapabilitySkill[] {
		const skills = new Map<string, CapabilitySkill>();
		for (const [name, skill] of this.extraSkills.entries()) {
			skills.set(name, skill);
		}
		for (const cap of this.capabilities.values()) {
			if (cap.skills) {
				for (const skill of cap.skills) {
					skills.set(skill.name, skill);
				}
			}
		}
		return Array.from(skills.values()).sort((a, b) => a.name.localeCompare(b.name));
	}
}
