/**
 * Hook render output → Pi registry and conversation configuration
 * (PI_UPGRADE_PLAN.md §1 `hooks/*` row, §2.1 `applyRender`, §7 step 6).
 *
 * Flue renders an agent function into an `AgentRuntimeConfig` plus lifecycle
 * declarations on its output channel (`hooks/render.ts`). `RenderedAgent`
 * carries exactly that, and the bridge turns it into:
 *
 * - one `registry.batch()` publishing the render's custom tools (and MCP
 *   tools, when the host resolves them), disposing the previous render's;
 * - `Conversation.setModel/setThinkingLevel/setActiveTools/setCompaction`
 *   for every conversation the render governs.
 *
 * Framework tools (`task`, `activate_skill`, `read_skill_resource`, sandbox
 * tools) and the system-prompt sections are registered once and read the
 * bridge's current state, so a render never rewrites their declarations.
 * Registry changes reach running work at Pi phase boundaries (§8 risk 7).
 */
import type { Context } from '@earendil-works/chord';
import type { Models } from '@earendil-works/pi-ai';
import {
	type Conversation,
	type ConversationId,
	type DocumentReader,
	type Registry,
	section,
	type ToolRegistration,
} from '@earendil-works/pi-durable';
import { ENTITY_TOOL_NAMES } from '../entity/tool-names.ts';
import { ToolNameConflictError } from '../errors.ts';
import type { CodeModeDeclaration } from '../hooks/use-code-mode.ts';
import type { QuestionsDeclaration } from '../hooks/use-questions.ts';
import type { AgentOutputChannel } from '../message-output.ts';
import type { McpConnectionDefinition } from '../mcp-types.ts';
import { FINISH_TOOL_NAME, GIVE_UP_TOOL_NAME } from '../result.ts';
import type { Sandbox } from '../sandbox.ts';
import type { ToolDefinition } from '../tool-types.ts';
import type {
	AgentRuntimeConfig,
	CompactionConfig,
	RegisteredSkill,
	SubagentDefinition,
	ThinkingLevel,
} from '../types.ts';
import { CODEMODE_TOOL_NAME, createCodemodeToolRegistration } from '../codemode/tool.ts';
import {
	compactionPolicyFor,
	modelLimits,
	parseModelSpecifier,
	thinkingLevelFor,
} from './config.ts';
import { FlueProfile } from './docs.ts';
import type { FlueLifecycle } from './hooks.ts';
import {
	ACTIVATE_SKILL_TOOL_NAME,
	activateSkillRegistration,
	packagedSkillReadRegistration,
	renderSkillsSection,
} from './skills.ts';
import { TASK_TOOL_NAME } from './subagent-tool.ts';
import {
	type FlueToolDeps,
	flueToolRegistration,
	SANDBOX_TOOL_NAMES,
	sandboxToolRegistrations,
} from './tools.ts';

/**
 * One render of the agent function, as the bridge consumes it. Every field is
 * the render's own output type (`renderAgentFunction` → `AgentRuntimeConfig`,
 * lifecycle declarations from `AgentOutputChannel`); build it with
 * {@link renderedAgentFrom}.
 */
export interface RenderedAgent {
	/** `useModel()` specifier, `provider-id/model-id`. */
	readonly model?: string;
	/** `useModel({ thinkingLevel })`; unset means `medium`. */
	readonly thinkingLevel?: ThinkingLevel;
	/** The composed instruction document (returned instruction + `useInstruction`). */
	readonly instructions?: string;
	/** Discovered workspace context (AGENTS.md), rendered after the instructions. */
	readonly context?: string;
	/** `useTool()` mounts, in call order. */
	readonly tools: readonly ToolDefinition[];
	/** `useSkill()` mounts plus discovered workspace skills. */
	readonly skills: readonly RegisteredSkill[];
	/** `useModel({ compaction })`: `false` disables threshold compaction. */
	readonly compaction?: false | CompactionConfig;
	/** `useMcpConnection()` declarations; resolved to tools by the host's MCP port. */
	readonly mcp: readonly McpConnectionDefinition[];
	/** `useSubagent()` declarations: the `task` roster. */
	readonly subagents: readonly SubagentDefinition[];
	/** `useAgentStart`/`useAgentFinish`/`useResponseStart`/`useResponseFinish` declarations. */
	readonly lifecycle: FlueLifecycle;
	/** Whether the render declared a sandbox (`useSandbox()`): the sandbox tools are offered only then. */
	readonly sandbox?: boolean;
	/**
	 * The sandbox factory's own tool list (`SandboxFactory.tools`), replacing
	 * the standard set. Keep the array identity stable across renders of the
	 * same sandbox: a new array re-registers the tools.
	 */
	readonly sandboxTools?: readonly ToolRegistration[];
	/** `useCodeMode()` declaration: offers the `codemode` tool over the render's other tools. */
	readonly codeMode?: CodeModeDeclaration;
	/** `useQuestions()` declaration: where questions go and when they expire. */
	readonly questions?: QuestionsDeclaration;
}

/** Assemble a {@link RenderedAgent} from one render's config and output channel. */
export function renderedAgentFrom(
	config: AgentRuntimeConfig,
	output?: Pick<
		AgentOutputChannel,
		'agentStarts' | 'agentFinishes' | 'responseStarts' | 'responseFinishes'
	>,
	extras: {
		readonly context?: string;
		readonly workspaceSkills?: readonly RegisteredSkill[];
		readonly codeMode?: CodeModeDeclaration;
		readonly questions?: QuestionsDeclaration;
	} = {},
): RenderedAgent {
	return {
		...(config.model !== undefined ? { model: config.model } : {}),
		...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
		...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
		...(extras.context !== undefined ? { context: extras.context } : {}),
		tools: config.tools ?? [],
		skills: [...(config.skills ?? []), ...(extras.workspaceSkills ?? [])],
		...(config.compaction !== undefined ? { compaction: config.compaction } : {}),
		mcp: config.mcpConnections ?? [],
		subagents: config.subagents ?? [],
		lifecycle: {
			agentStarts: output?.agentStarts ?? [],
			agentFinishes: output?.agentFinishes ?? [],
			responseStarts: output?.responseStarts ?? [],
			responseFinishes: output?.responseFinishes ?? [],
		},
		sandbox: config.sandbox !== undefined,
		...(extras.codeMode !== undefined ? { codeMode: extras.codeMode } : {}),
		...(extras.questions !== undefined ? { questions: extras.questions } : {}),
	};
}

/** Resolves `useMcpConnection` declarations to Pi tools (`mcp.ts`). */
export type McpToolResolver = (
	connections: readonly McpConnectionDefinition[],
	context: Context,
) => Promise<readonly ToolRegistration[]>;

export interface RegistryBridgeOptions {
	readonly registry: Registry;
	readonly models: Models;
	/** The instance sandbox; absent means no sandbox tools (framework tools stay). */
	readonly sandbox?: Sandbox;
	readonly tools?: FlueToolDeps;
	readonly mcp?: McpToolResolver;
	/** The `task` tool registration (built by the host from `subagent-tool.ts`). */
	readonly taskTool: ToolRegistration;
	readonly onReport: (error: unknown) => void;
}

const SECTION_INSTRUCTIONS = 'flue_instructions';
const SECTION_CONTEXT = 'flue_context';
const SECTION_SKILLS = 'flue_skills';
const SECTION_AGENTS = 'flue_agents';

const FRAMEWORK_TOOLS = new Set([
	TASK_TOOL_NAME,
	CODEMODE_TOOL_NAME,
	ACTIVATE_SKILL_TOOL_NAME,
	'read_skill_resource',
	FINISH_TOOL_NAME,
	GIVE_UP_TOOL_NAME,
]);

function renderAgentCatalog(subagents: readonly { name: string; description: string }[]): string {
	if (subagents.length === 0) {
		return [
			'## Available Agents',
			'',
			'None. No subagents are currently declared, so the `task` tool has no valid `agent` value — do not call it unless an agent is introduced later in the conversation.',
		].join('\n');
	}
	return [
		'## Available Agents',
		'',
		'You can delegate focused work to one of these agents with the `task` tool, naming the agent to use. The list can change over the conversation — additions and removals are announced.',
		'',
		...subagents.map(
			(agent) => `- **${agent.name}**${agent.description ? ` — ${agent.description}` : ''}`,
		),
	].join('\n');
}

/** The render state and registrations of one Flue Pi host. */
export class RegistryBridge {
	readonly #options: RegistryBridgeOptions;
	#current: RenderedAgent | undefined;
	/** Custom tools of the current render, by name. */
	#renderTools = new Map<string, ToolDefinition>();
	readonly #defaultSandboxTools: readonly ToolRegistration[];
	/** The sandbox tool set registered now. */
	#sandboxTools: readonly ToolRegistration[] = [];
	/** Configuration last applied per conversation, so an unchanged render writes nothing. */
	#applied = new Map<number, string>();
	/** Tools a delegation registered; they outlive renders (a child may still run). */
	#delegateTools = new Map<string, ToolDefinition>();
	#delegateToolList: ToolDefinition[] = [];
	/** Every skill and subagent any render or delegate declared, by name. */
	#skills = new Map<string, RegisteredSkill>();
	#subagents = new Map<string, SubagentDefinition>();
	#skillReadIds = '';

	constructor(options: RegistryBridgeOptions) {
		this.#options = options;
		const { registry } = options;
		this.#defaultSandboxTools = options.sandbox ? sandboxToolRegistrations(options.sandbox) : [];
		registry.install({
			name: 'flue.static',
			tools: [
				options.taskTool,
				activateSkillRegistration((id, read, context) => this.skillsFor(id, read, context)),
			],
			sections: [
				section(
					SECTION_INSTRUCTIONS,
					async (input, context) => {
						const profile = await input.read.snapshot(FlueProfile, input.conversationId, context);
						return profile?.agent ? profile.instructions : this.#current?.instructions;
					},
					{ tag: false },
				),
				section(
					SECTION_CONTEXT,
					async (input, context) => {
						const profile = await input.read.snapshot(FlueProfile, input.conversationId, context);
						return profile?.agent ? undefined : this.#current?.context;
					},
					{ tag: false },
				),
				section(
					SECTION_SKILLS,
					async (input, context) =>
						renderSkillsSection(await this.skillsFor(input.conversationId, input.read, context)),
					{ tag: false },
				),
				section(
					SECTION_AGENTS,
					async (input, context) =>
						renderAgentCatalog(await this.rosterFor(input.conversationId, input.read, context)),
					{ tag: false },
				),
			],
		});
	}

	/** The render currently applied, if any. */
	get current(): RenderedAgent | undefined {
		return this.#current;
	}

	/** The lifecycle declarations governing a conversation: the root agent's, never a delegate's. */
	async lifecycleFor(
		conversationId: ConversationId,
		read: DocumentReader,
		context: Context,
	): Promise<FlueLifecycle | undefined> {
		const profile = await read.snapshot(FlueProfile, conversationId, context);
		return profile?.agent ? undefined : this.#current?.lifecycle;
	}

	/** Skills visible to a conversation: the delegate profile's, else the root render's. */
	async skillsFor(
		conversationId: ConversationId,
		read: DocumentReader,
		context: Context,
	): Promise<readonly RegisteredSkill[]> {
		const profile = await read.snapshot(FlueProfile, conversationId, context);
		if (profile?.agent) {
			return profile.skills.flatMap((name) => {
				const skill = this.#skills.get(name);
				return skill ? [skill] : [];
			});
		}
		return this.#current?.skills ?? [];
	}

	/** The `task` roster of a conversation: the delegate profile's, else the root render's. */
	async rosterFor(
		conversationId: ConversationId,
		read: DocumentReader,
		context: Context,
	): Promise<readonly SubagentDefinition[]> {
		const profile = await read.snapshot(FlueProfile, conversationId, context);
		if (profile?.agent) {
			return profile.subagents.flatMap((name) => {
				const subagent = this.#subagents.get(name);
				return subagent ? [subagent] : [];
			});
		}
		return this.#current?.subagents ?? [];
	}

	/** Names of the framework and sandbox tools every Flue conversation is offered. */
	baseToolNames(): string[] {
		const names = this.#options.registry.snapshot().tools().map((t) => t.tool.name);
		return [
			...this.#sandboxTools.map((tool) => tool.name),
			TASK_TOOL_NAME,
			ACTIVATE_SKILL_TOOL_NAME,
			...(names.includes('read_skill_resource') ? ['read_skill_resource'] : []),
			// A2A entity tools, once `entity/tools-facet.ts` registered them.
			...ENTITY_TOOL_NAMES.filter((name) => names.includes(name)),
		];
	}

	/**
	 * Publish one render: its custom and MCP tools as extensions, then
	 * the model, thinking level, and active tools of every governed conversation.
	 */
	/** Every tool name the current render offers its conversations. */
	activeToolNames(): string[] {
		return [...this.#activeNames];
	}

	#activeNames: string[] = [];

	async apply(
		render: RenderedAgent,
		conversations: readonly Conversation[],
		context: Context,
		options: { readonly force?: boolean } = {},
	): Promise<void> {
		const registered = this.#options.registry.snapshot().tools().map((t) => t.tool.name);
		const sandboxTools =
			render.sandbox === false ? [] : (render.sandboxTools ?? this.#defaultSandboxTools);
		const reserved = new Set([
			...SANDBOX_TOOL_NAMES,
			...sandboxTools.map((tool) => tool.name),
			...FRAMEWORK_TOOLS,
			...ENTITY_TOOL_NAMES.filter((name) => registered.includes(name)),
		]);
		const seen = new Set<string>();
		for (const tool of render.tools) {
			if (reserved.has(tool.name)) {
				throw new ToolNameConflictError({
					name: tool.name,
					conflict: 'reserved',
					source: 'custom',
					reserved: [...reserved],
				});
			}
			if (seen.has(tool.name)) {
				throw new ToolNameConflictError({
					name: tool.name,
					conflict: 'duplicate',
					source: 'custom',
				});
			}
			const delegated = this.#delegateTools.get(tool.name);
			if (delegated !== undefined && delegated !== tool) {
				throw new ToolNameConflictError({
					name: tool.name,
					conflict: 'duplicate',
					source: 'custom',
				});
			}
			seen.add(tool.name);
		}
		const mcpTools =
			render.mcp.length > 0 && this.#options.mcp
				? await this.#options.mcp(render.mcp, context)
				: [];
		if (render.mcp.length > 0 && !this.#options.mcp) {
			this.#options.onReport(
				new Error(
					'[flue] useMcpConnection() declarations need an MCP port on the Pi host; they were skipped.',
				),
			);
		}
		for (const skill of render.skills) this.#skills.set(skill.name, skill);
		for (const subagent of render.subagents) this.#subagents.set(subagent.name, subagent);

		const { registry } = this.#options;
		if (sandboxTools !== this.#sandboxTools) {
			if (sandboxTools.length > 0) {
				registry.install({ name: 'flue.sandbox', tools: sandboxTools });
			} else {
				registry.uninstall({ name: 'flue.sandbox' });
			}
			this.#sandboxTools = sandboxTools;
		}

		if (render.tools.length > 0) {
			registry.install({
				name: 'flue.render.tools',
				tools: render.tools.map((tool) => flueToolRegistration(tool, this.#options.tools)),
			});
		} else {
			registry.uninstall({ name: 'flue.render.tools' });
		}
		this.#renderTools = new Map(render.tools.map((tool) => [tool.name, tool]));

		if (mcpTools.length > 0) {
			registry.install({ name: 'flue.mcp', tools: mcpTools });
		} else {
			registry.uninstall({ name: 'flue.mcp' });
		}

		if (render.codeMode) {
			registry.install({
				name: 'flue.codemode',
				tools: [
					createCodemodeToolRegistration({
						...render.codeMode,
						tools: [
							...sandboxTools,
							...render.tools.map((tool) => flueToolRegistration(tool, this.#options.tools)),
							...mcpTools,
						],
					}),
				],
			});
		} else {
			registry.uninstall({ name: 'flue.codemode' });
		}

		this.#syncSkillRead(render.skills);
		this.#current = render;

		const model = render.model !== undefined ? parseModelSpecifier(render.model) : undefined;
		const policy = compactionPolicyFor(render.compaction, modelLimits(this.#options.models, model));
		const active = [
			...this.baseToolNames(),
			...render.tools.map((tool) => tool.name),
			...mcpTools.map((tool) => tool.name),
			...(render.codeMode ? [CODEMODE_TOOL_NAME] : []),
		];
		this.#activeNames = active;
		const thinkingLevel = thinkingLevelFor(render.thinkingLevel);
		const fingerprint = JSON.stringify([model, thinkingLevel, active, policy]);
		for (const conversation of conversations) {
			if (!options.force && this.#applied.get(conversation.id) === fingerprint) continue;
			await conversation.configure(
				{
					model: model ?? null,
					thinkingLevel: thinkingLevel ?? null,
					tools: active.map((name) => ({ name }) as unknown as ToolRegistration),
					compaction: policy ?? null,
				},
				context,
			);
			this.#applied.set(conversation.id, fingerprint);
		}
	}

	/**
	 * Register a delegate's own tools (rendered at delegation time) and remember
	 * its skills and nested subagents. Returns the tool names the delegate's
	 * conversation is offered. A name already bound to a different definition
	 * is a conflict: one registry serves every conversation of the instance.
	 */
	registerDelegate(delegate: {
		readonly tools?: readonly ToolDefinition[];
		readonly skills?: readonly RegisteredSkill[];
		readonly subagents?: readonly SubagentDefinition[];
	}): string[] {
		const { registry } = this.#options;
		const fresh: ToolDefinition[] = [];
		for (const tool of delegate.tools ?? []) {
			const bound =
				this.#delegateTools.get(tool.name) ?? this.#renderTools.get(tool.name);
			if (bound !== undefined && bound !== tool) {
				throw new ToolNameConflictError({
					name: tool.name,
					conflict: 'duplicate',
					source: 'custom',
				});
			}
			if (bound === undefined) fresh.push(tool);
			this.#delegateTools.set(tool.name, tool);
		}
		for (const skill of delegate.skills ?? []) this.#skills.set(skill.name, skill);
		for (const subagent of delegate.subagents ?? []) this.#subagents.set(subagent.name, subagent);
		if (fresh.length > 0) {
			this.#delegateToolList.push(...fresh);
			registry.install({
				name: 'flue.delegate.tools',
				tools: this.#delegateToolList.map((tool) => flueToolRegistration(tool, this.#options.tools)),
			});
		}
		this.#syncSkillRead([...this.#skills.values()]);
		return [...this.baseToolNames(), ...(delegate.tools ?? []).map((tool) => tool.name)];
	}

	/** A subagent definition by name, from any render or delegate seen so far. */
	subagent(name: string): SubagentDefinition | undefined {
		return this.#subagents.get(name);
	}

	/** Keep one `read_skill_resource` registration covering every packaged skill with resources. */
	#syncSkillRead(skills: readonly RegisteredSkill[]): void {
		const all = new Map<string, RegisteredSkill>();
		for (const skill of [...this.#skills.values(), ...skills]) all.set(skill.name, skill);
		const registration = packagedSkillReadRegistration([...all.values()]);
		const ids = [...all.keys()].sort().join('\n');
		if (ids === this.#skillReadIds) return;
		if (registration) {
			this.#options.registry.install({
				name: 'flue.skill_read',
				tools: [registration],
			});
		} else {
			this.#options.registry.uninstall({ name: 'flue.skill_read' });
		}
		this.#skillReadIds = ids;
	}
}
