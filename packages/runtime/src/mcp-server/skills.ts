/**
 * Skills Manager & Dual Projection.
 *
 * Implements canonical Skill storage as Resources first (skill://),
 * projected to the Skills extension when enabled, or ordinary Resources when core-only.
 *
 * INVARIANT: Every Skill is unconditionally readable as an ordinary Resource.
 *
 * Reference: docs/mcp-capability-projection.md § 6
 */

import type { CapabilitySkill } from './types.ts';
import type { CapabilityRegistry } from './registry.ts';

export class SkillManager {
	constructor(private readonly registry: CapabilityRegistry) {}

	/**
	 * Register a new canonical skill package.
	 */
	registerSkill(skill: CapabilitySkill): void {
		this.registry.registerSkill(skill);
	}

	/**
	 * Retrieve a skill by name.
	 */
	getSkill(name: string): CapabilitySkill | undefined {
		const skills = this.registry.getAllSkills();
		return skills.find((s) => s.name === name);
	}

	/**
	 * List all skills for native skills/list.
	 */
	listSkills(): Array<{ name: string; description: string; uri: string; entryPoint?: string }> {
		const skills = this.registry.getAllSkills();
		return skills.map((s) => ({
			name: s.name,
			description: s.description,
			uri: s.uri,
			entryPoint: s.entryPoint,
		}));
	}

	/**
	 * Retrieve full skill definition for native skills/get.
	 */
	getSkillDetails(name: string): CapabilitySkill | undefined {
		return this.getSkill(name);
	}

	/**
	 * Read a skill:// URI as an MCP resource.
	 * e.g. skill://git-workflow/SKILL.md or skill://git-workflow/scripts/check.sh
	 */
	readSkillResource(uri: string): { content: string; mimeType: string } {
		const match = uri.match(/^skill:\/\/([^/]+)\/(.+)$/);
		if (!match) {
			throw new Error(`Invalid skill URI: ${uri}`);
		}
		const skillName = match[1] ?? '';
		const subpath = match[2] ?? '';

		const skill = this.getSkill(skillName);
		if (!skill) {
			throw new Error(`Skill '${skillName}' not found.`);
		}

		// Find file by matching path or URI suffix
		const file = skill.files.find(
			(f) =>
				f.path === subpath ||
				f.uri === uri ||
				f.path.replace(/^\/+/, '') === subpath.replace(/^\/+/, ''),
		);

		if (!file) {
			throw new Error(`File '${subpath}' not found in skill '${skillName}'.`);
		}

		return {
			content: file.content,
			mimeType: file.mimeType ?? (subpath.endsWith('.sh') ? 'application/x-sh' : 'text/markdown'),
		};
	}

	/**
	 * Collect all skill resource descriptors for core resources/list.
	 */
	listSkillResources(): Array<{ uri: string; name: string; description: string; mimeType: string }> {
		const result: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];
		const skills = this.registry.getAllSkills();

		for (const skill of skills) {
			// Always list the root SKILL.md
			result.push({
				uri: skill.uri,
				name: `${skill.name} (Skill Guide)`,
				description: skill.description,
				mimeType: 'text/markdown',
			});

			// Also list ancillary files
			for (const file of skill.files) {
				if (file.uri !== skill.uri) {
					result.push({
						uri: file.uri,
						name: `${skill.name}: ${file.path}`,
						description: `Reference asset or script for skill ${skill.name}.`,
						mimeType: file.mimeType ?? 'text/markdown',
					});
				}
			}
		}

		return result.sort((a, b) => a.uri.localeCompare(b.uri));
	}
}
