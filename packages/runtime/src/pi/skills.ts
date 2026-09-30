/**
 * Skills on Pi (PI_UPGRADE_PLAN.md §1 skill rows, §7 step 10).
 *
 * Authoring and packaging stay Flue's (`useSkill`, `defineSkill`, SKILL.md
 * imports, `.agents/skills` discovery). The model-facing surface is Pi's:
 * the catalog is the `flue.skills` system-prompt section rendered by
 * `formatSkillsForSystemPrompt`, and `activate_skill` answers with
 * `formatSkillInvocation`, both from `pi-agent-core`.
 */
import type { Context } from '@earendil-works/chord';
import {
	formatSkillInvocation,
	formatSkillsForSystemPrompt,
	type Skill as PiSkill,
} from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { ConversationId, DocumentReader, ToolRegistration } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { createPackagedSkillReadTool, formatPackagedSkillFilePath } from '../agent.ts';
import { decodeBase64 } from '../base64.ts';
import { isSkillDefinition, packageSkillDefinition } from '../skill-definition.ts';
import { parseSkillMarkdown } from '../skill-frontmatter.ts';
import { getSkillReferenceDirectory } from '../skill-package.ts';
import type { PackagedSkillDirectory, RegisteredSkill, WorkspaceSkill } from '../types.ts';
import { agentToolRegistration } from './tools.ts';

export const ACTIVATE_SKILL_TOOL_NAME = 'activate_skill';
export const SKILLS_SECTION_KEY = 'flue.skills';

/** Resolve the skills visible to one conversation (root render or delegate profile). */
export type SkillResolver = (
	conversationId: ConversationId,
	read: DocumentReader,
	context: Context,
) => Promise<readonly RegisteredSkill[]>;

function isWorkspaceSkill(skill: RegisteredSkill): skill is WorkspaceSkill {
	return '__flueWorkspaceSkill' in skill;
}

/** The packaged directory behind a registered skill, when it has one. */
export function packagedDirectoryOf(skill: RegisteredSkill): PackagedSkillDirectory | undefined {
	if (isWorkspaceSkill(skill)) return undefined;
	if (isSkillDefinition(skill)) return packageSkillDefinition(skill);
	return getSkillReferenceDirectory(skill);
}

/** Model-visible location of a skill's SKILL.md. */
export function skillFilePath(skill: RegisteredSkill): string {
	if (isWorkspaceSkill(skill)) return skill.skillMdPath;
	const directory = packagedDirectoryOf(skill);
	return directory
		? formatPackagedSkillFilePath(directory.id, 'SKILL.md')
		: `/.flue/packaged-skills/${encodeURIComponent(skill.name)}/SKILL.md`;
}

/** Catalog entry: Pi's `Skill` without its (lazily loaded) content. */
export function catalogSkill(skill: RegisteredSkill): PiSkill {
	return { name: skill.name, description: skill.description, content: '', filePath: skillFilePath(skill) };
}

/** The `flue.skills` section text for a set of skills; `undefined` omits the section. */
export function renderSkillsSection(skills: readonly RegisteredSkill[]): string | undefined {
	const text = formatSkillsForSystemPrompt(skills.map(catalogSkill));
	return text.length === 0 ? undefined : text;
}

/** Load the full Pi skill (instructions included) for activation. */
export async function loadPiSkill(
	skill: RegisteredSkill,
	env: ExecutionEnv | undefined,
	context: Context,
): Promise<PiSkill> {
	const filePath = skillFilePath(skill);
	if (isSkillDefinition(skill)) {
		return { name: skill.name, description: skill.description, content: skill.instructions, filePath };
	}
	let raw: string;
	if (isWorkspaceSkill(skill)) {
		if (!env) throw new Error(`[flue] Workspace skill "${skill.name}" needs a sandbox to load.`);
		const read = await env.readTextFile(skill.skillMdPath, context);
		if (!read.ok) throw read.error;
		raw = read.value;
	} else {
		const directory = getSkillReferenceDirectory(skill);
		const file = directory?.files['SKILL.md'];
		if (!directory || !file) throw new Error(`[flue] Packaged skill "${skill.name}" is missing SKILL.md.`);
		raw = new TextDecoder().decode(decodeBase64(file.content));
	}
	const parsed = parseSkillMarkdown(raw, { directoryName: skill.name, path: filePath });
	return { name: skill.name, description: skill.description, content: parsed.body, filePath };
}

/**
 * `activate_skill` as a Pi tool. The schema is a plain string (never an enum
 * of names) so a dynamically declared skill does not rewrite the tool spec;
 * an unknown name is a factual miss listing what is available, not an error.
 * Activation only reads, so an interrupted call is replay-safe.
 */
export function activateSkillRegistration(resolve: SkillResolver): ToolRegistration {
	return {
		name: ACTIVATE_SKILL_TOOL_NAME,
		description:
			'Load the full instructions for one available skill before performing work that matches its description. Supporting resources remain lazy until explicitly read.',
		parameters: Type.Object({ name: Type.String({ description: 'Name of the skill to activate' }) }),
		replay: 'safe',
		async execute(args, api, context) {
			const name =
				typeof args === 'object' && args !== null && !Array.isArray(args) && typeof args.name === 'string'
					? args.name
					: '';
			const skills = await resolve(api.conversationId, api, context);
			const skill = skills.find((candidate) => candidate.name === name);
			if (!skill) {
				const available = skills.map((candidate) => candidate.name);
				return {
					content: [
						{
							type: 'text',
							text:
								available.length > 0
									? `Skill "${name}" is not available. Available skills: ${available.join(', ')}.`
									: `Skill "${name}" is not available. No skills are currently declared.`,
						},
					],
					details: { skill: name, available },
				};
			}
			const loaded = await loadPiSkill(skill, api.env, context);
			return {
				content: [{ type: 'text', text: formatSkillInvocation(loaded) }],
				details: { skill: name },
			};
		},
	};
}

/**
 * `read_skill_resource` over the packaged skills that carry supporting files,
 * or `undefined` when none do. Packaged files live in memory, not in the
 * sandbox, so Pi's `read` (which goes through `api.env`) cannot serve them.
 */
export function packagedSkillReadRegistration(
	skills: readonly RegisteredSkill[],
): ToolRegistration | undefined {
	const packaged: Record<string, PackagedSkillDirectory> = {};
	for (const skill of skills) {
		const directory = packagedDirectoryOf(skill);
		if (directory && Object.keys(directory.files).some((path) => path !== 'SKILL.md')) {
			packaged[directory.id] = directory;
		}
	}
	if (Object.keys(packaged).length === 0) return undefined;
	return agentToolRegistration(createPackagedSkillReadTool(packaged), { replay: 'safe' });
}
