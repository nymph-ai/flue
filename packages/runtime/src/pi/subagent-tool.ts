/**
 * Subagents and `session.task()` on Pi (PI_UPGRADE_PLAN.md §1 `agent.ts`
 * `task` and `harness-tool-lineage.ts` rows, §7 step 11).
 *
 * Pi's owned-conversation pattern (`durable/test/examples/22-24`): a
 * delegation is a durable `flue.delegate` task that owns a child
 * conversation, submits the prompt there under a stable request id, waits,
 * and completes with the child's answer. Ownership gives Flue's semantics
 * for free:
 *
 * - aborting the parent call (or `session.abort()`) aborts the child;
 * - the parent call finishes only once the child's work drains;
 * - after a crash the task resumes from its checkpoint, the child is found
 *   again by owner, and the request id returns the submission made before.
 *
 * The model-facing `task` tool keeps Flue's schema and roster rules and
 * creates the delegate task as a child task of its own tool task, recorded
 * in a task-scoped doc so a replay-safe rerun finds it instead of starting a
 * second one. Delegation depth is the length of the conversation owner
 * chain, capped at Flue's `MAX_DELEGATION_DEPTH`.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';
import {
	AgentDoc,
	AssistantEntry,
	type ConversationId,
	type DocumentReader,
	defineTask,
	type Harness,
	type ModelRef,
	type TaskId,
	type ToolExecutionResult,
	type ToolRegistration,
	type Tx,
} from '@earendil-works/pi-durable';
import { DelegationDepthExceededError } from '../errors.ts';
import { resolveSubagentDefinition } from '../hooks/render.ts';
import type { ToolDefinition } from '../tool-types.ts';
import type { RegisteredSkill, SubagentDefinition, ThinkingLevel } from '../types.ts';
import { parseModelSpecifier } from './config.ts';
import { FlueDelegation, FlueProfile } from './docs.ts';

export const TASK_TOOL_NAME = 'task';
export const DELEGATE_TASK_NAME = 'flue.delegate';
/** Flue's delegation depth cap (`session.ts` `MAX_DELEGATION_DEPTH`). */
export const MAX_DELEGATION_DEPTH = 4;

/** What a delegation runs: the delegate's rendered world, frozen as JSON at delegation time. */
export type DelegateInput = {
	readonly agent: string;
	readonly prompt: string;
	readonly model?: ModelRef;
	readonly thinkingLevel?: ThinkingLevel;
	readonly instructions?: string;
	readonly tools: readonly string[];
	readonly skills: readonly string[];
	readonly subagents: readonly string[];
	readonly maxDepth: number;
};

type DelegateState = { phase: 'start' } | { phase: 'run'; child: number; depth: number };

export type DelegateResult = { text: string; conversationId: number };

function answerText(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** Owner hops from `conversationId` up to an ownerless conversation. */
async function ownerDepth(tx: Tx, conversationId: ConversationId): Promise<number> {
	let depth = 0;
	let current = await tx.conversation(conversationId);
	while (current?.owner !== undefined) {
		depth += 1;
		current = await tx.conversation(current.owner.conversationId);
	}
	return depth;
}

/** Durable delegation: owns the child conversation and completes with its answer. */
export const DelegateTask = defineTask<DelegateInput, DelegateState, DelegateResult>({
	name: DELEGATE_TASK_NAME,
	version: 1,
	initial: () => ({ phase: 'start' }),
	phases: {
		start: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const parentDepth = await ownerDepth(tx, runtime.conversationId);
				if (parentDepth >= task.input.maxDepth) {
					const error = new DelegationDepthExceededError({ maxDepth: task.input.maxDepth });
					return {
						status: 'terminal',
						outcome: {
							status: 'failed',
							error: { message: error.message, detail: { type: 'delegation_depth_exceeded' } },
						},
					};
				}
				// Ownership records the child, so a rerun finds it instead of creating another.
				const existing = (await tx.scanConversations({ ownerTaskId: runtime.taskId }, 1)).items[0];
				const child =
					existing?.id ??
					(await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } })).id;
				if (existing === undefined) {
					const parent = await tx.doc(AgentDoc, runtime.conversationId);
					const config = await tx.doc(AgentDoc, child);
					const model = task.input.model ?? parent.model;
					if (model !== undefined) config.model = { provider: model.provider, modelId: model.modelId };
					config.thinkingLevel = task.input.thinkingLevel ?? parent.thinkingLevel;
					config.tools = [...task.input.tools];
					const profile = await tx.doc(FlueProfile, child);
					profile.agent = task.input.agent;
					if (task.input.instructions !== undefined) profile.instructions = task.input.instructions;
					profile.skills = [...task.input.skills];
					profile.subagents = [...task.input.subagents];
					profile.depth = parentDepth + 1;
				}
				return { status: 'running', checkpoint: { phase: 'run', child, depth: parentDepth + 1 } };
			}, context);
		},
		run: async (task, runtime, context) => {
			const child = task.state.checkpoint.child as ConversationId;
			const conversation = await runtime.conversation(child, context);
			if (!conversation) throw new Error(`[flue] Delegation ${task.id} lost its child conversation ${child}.`);
			const submission = await conversation.submit(
				{ type: 'input', content: task.input.prompt, requestId: `flue.delegate:${task.id}` },
				context,
			);
			const settled = await submission.wait(context);
			if (settled.status !== 'done' || settled.type !== 'input') {
				const reason = settled.status === 'unanswered' ? settled.reason : settled.status;
				await runtime.commit(
					() => ({
						status: 'terminal',
						outcome:
							reason === 'aborted'
								? { status: 'aborted', reason }
								: {
										status: 'failed',
										error: {
											message: `Subagent "${task.input.agent}" did not answer: ${reason}`,
											...(settled.status === 'unanswered' && settled.detail !== undefined
												? { detail: settled.detail }
												: {}),
										},
									},
					}),
					context,
				);
				return;
			}
			const answer = settled.answer;
			// `runtime.entry` sees only the task's own conversation; the answer lives
			// in the child, so read it through the commit's global entry lookup.
			await runtime.commit(async (tx) => {
				const entry = await tx.entry(AssistantEntry, answer);
				const text = answerText(entry?.model?.[0] as AssistantMessage | undefined);
				return { status: 'terminal', outcome: { status: 'completed', result: { text, conversationId: child } } };
			}, context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

/** Resolves the roster and registers delegate worlds; the registry bridge implements it. */
export interface DelegationHost {
	rosterFor(conversationId: ConversationId, read: DocumentReader, context: Context): Promise<readonly SubagentDefinition[]>;
	registerDelegate(delegate: {
		readonly tools?: readonly ToolDefinition[];
		readonly skills?: readonly RegisteredSkill[];
		readonly subagents?: readonly SubagentDefinition[];
	}): string[];
}

/**
 * Render a delegate at delegation time (fresh frame, per Flue's contract) and
 * freeze its world into a `DelegateInput`.
 */
export function prepareDelegation(
	host: DelegationHost,
	subagent: SubagentDefinition,
	prompt: string,
	maxDepth = MAX_DELEGATION_DEPTH,
): DelegateInput {
	const resolved = resolveSubagentDefinition(subagent, { kind: 'user', body: prompt });
	const tools = host.registerDelegate({
		...(resolved.tools ? { tools: resolved.tools } : {}),
		...(resolved.skills ? { skills: resolved.skills } : {}),
		...(resolved.subagents ? { subagents: resolved.subagents } : {}),
	});
	return {
		agent: subagent.name,
		prompt,
		...(resolved.model !== undefined ? { model: parseModelSpecifier(resolved.model) } : {}),
		...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
		...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
		tools,
		skills: (resolved.skills ?? []).map((skill) => skill.name),
		subagents: (resolved.subagents ?? []).map((each) => each.name),
		maxDepth,
	};
}

function describeOutcome(outcome: { status: string; error?: { message: string }; reason?: string }): string {
	if (outcome.error) return outcome.error.message;
	return `Subagent task ended ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ''}`;
}

/**
 * The model-facing `task` tool. Schema and prose match Flue's: `agent` is a
 * required plain string (never an enum, so roster changes never rewrite the
 * tool spec), the roster lives in the `flue_agents` prompt section, and an
 * undeclared name is a factual miss listing the available agents.
 */
export function createSubagentToolRegistration(host: DelegationHost): ToolRegistration {
	return {
		name: TASK_TOOL_NAME,
		description:
			'Delegate a focused task to a detached child agent with its own context. ' +
			'Use this for independent research, file exploration, or parallel work. ' +
			'The task returns only its final answer to this conversation. ' +
			'Agents available for delegation are listed under "Available Agents" in the system prompt.',
		parameters: Type.Object({
			description: Type.Optional(Type.String({ description: 'Short human-readable label for the delegated work' })),
			prompt: Type.String({ description: 'Focused instructions for the child agent' }),
			agent: Type.String({
				minLength: 1,
				description:
					'Subagent to run the task with, from the list of currently available agents. ' +
					'Agents that have been removed from the list are no longer usable (until re-introduced, if ever).',
			}),
		}),
		// A rerun finds the delegation it already started (task-scoped doc) and
		// the child's submission (request id), so replay never duplicates work.
		replay: 'safe',
		async execute(args, api, context): Promise<ToolExecutionResult> {
			const { prompt, agent } = args as { prompt: string; agent: string };
			const roster = await host.rosterFor(api.conversationId, api, context);
			const subagent = roster.find((candidate) => candidate.name === agent);
			if (!subagent) {
				const available = roster.map((candidate) => candidate.name);
				return {
					content: [
						{
							type: 'text',
							text:
								available.length > 0
									? `Agent "${agent}" is not available. Available agents: ${available.join(', ')}.`
									: `Agent "${agent}" is not available. No subagents are currently declared.`,
						},
					],
					details: { agent, available },
				};
			}
			let taskId = await api.commit(async (tx) => (await tx.doc(FlueDelegation, api.taskId)).taskId, context);
			if (taskId === null) {
				const input = prepareDelegation(host, subagent, prompt);
				taskId = await api.commit(async (tx) => {
					const record = await tx.doc(FlueDelegation, api.taskId);
					if (record.taskId !== null) return record.taskId;
					const id = await tx.createTask(DelegateTask, input, {
						ownership: { kind: 'task', taskId: api.taskId },
					});
					record.taskId = id;
					return id;
				}, context);
			}
			const settled = await api.waitForTask(taskId as TaskId<DelegateResult>, context);
			const outcome = settled.state.outcome;
			if (outcome.status !== 'completed') throw new Error(describeOutcome(outcome));
			return {
				content: [{ type: 'text', text: outcome.result.text }],
				details: {
					taskId: String(taskId),
					session: String(outcome.result.conversationId),
					agent,
				} satisfies { [key: string]: JsonValue },
			};
		},
	};
}

/**
 * `session.task()`: delegate from the host (no tool call). The delegation is
 * a conversation-owned task, so `conversation.abort()` reaches it.
 */
export async function runDelegatedTask(
	harness: Harness,
	conversationId: ConversationId,
	input: DelegateInput,
	context: Context,
): Promise<DelegateResult> {
	const conversation = await harness.conversation(conversationId, context);
	if (!conversation) throw new Error(`[flue] Conversation ${conversationId} does not exist.`);
	const id = await conversation.commit(
		(tx) => tx.createTask(DelegateTask, input, { ownership: { kind: 'conversation' } }),
		context,
	);
	const settled = await harness.waitForTask(id, context);
	const outcome = settled.state.outcome;
	if (outcome.status !== 'completed') throw new Error(describeOutcome(outcome));
	return outcome.result;
}
