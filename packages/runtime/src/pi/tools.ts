/**
 * Flue tools as Pi Durable `ToolRegistration`s (PI_UPGRADE_PLAN.md §1
 * `tool-adapter.ts`, `result.ts`, `agent.ts` rows; §7 step 6).
 *
 * - A Flue `ToolDefinition` keeps its authoring contract: valibot input
 *   parsing, the `{ output, terminate }` envelope, JSON output validation,
 *   per-call deadlines. `durable: true` becomes `replay: "safe"` and its
 *   `step.do()` memos become Pi task memos, so a rerun after a crash replays
 *   completed steps instead of re-running them. `terminate` becomes the Pi
 *   `control: { terminate: true }`.
 * - `read`/`write`/`edit`/`bash` are Pi's portable tools over `api.env`
 *   (`execution-env.ts`); `grep`/`glob` stay Flue's, re-registered.
 * - The structured-result pair (`finish`/`give_up`) terminates the run; the
 *   accepted value rides the tool-result entry's `details`, where
 *   `resultFromToolDetails` reads it back for the settlement.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';
import type {
	ToolExecutionApi,
	ToolExecutionMode,
	ToolExecutionResult,
	ToolRegistration,
} from '@earendil-works/pi-durable';
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from '@earendil-works/pi-durable/tools';
import type * as v from 'valibot';
import { composeTimeoutSignal, raceToolWithDeadline } from '../abort.ts';
import { createGlobTool, createGrepTool } from '../agent.ts';
import { createResultTools, FINISH_TOOL_NAME, GIVE_UP_TOOL_NAME } from '../result.ts';
import { valibotToJsonSchema } from '../schema.ts';
import type { Sandbox } from '../sandbox.ts';
import {
	assertToolDefinition,
	claimStepName,
	cloneStepValue,
	parseToolInput,
	resolveToolRun,
} from '../tool.ts';
import { mcpToolOutput } from '../mcp.ts';
import { runInQuestionCall } from '../questions.ts';
import {
	getMcpToolSource,
	getPreparedToolAdapter,
	type McpToolSource,
	registerMcpToolSource,
} from '../tool-adapter.ts';
import { beginQuestionableCall, cancelQuestion } from './questions.ts';
import type { ToolDefinition, ToolStep } from '../tool-types.ts';
import type { FlueHarness, FlueLogger } from '../types.ts';

/** Invocation-scoped harness handed to a `harness: true` tool, closed when its run settles. */
export interface FlueToolHarnessScope {
	readonly harness: FlueHarness;
	close(): Promise<void>;
}

/** Host services a Flue tool invocation may need; wired by the coordinator cutover (step 8). */
export interface FlueToolDeps {
	/** Materialize the harness of a `harness: true` tool call. Absent: such tools fail with an error result. */
	readonly harness?: (
		call: {
			readonly tool: string;
			readonly api: ToolExecutionApi;
			readonly signal: AbortSignal | undefined;
		},
		context: Context,
	) => Promise<FlueToolHarnessScope>;
	/** Progress logger of one call (`ctx.log`); never model-visible. Default: discard. */
	readonly logger?: (tool: string, callId: string) => FlueLogger;
	/**
	 * Runs around every Flue tool execution: tracing interception and the
	 * flush of what the call wrote through hooks (`usePersistentState`,
	 * `useDataWriter`), committed through the call's own `api` before its
	 * result entry.
	 */
	readonly around?: <T>(
		call: { readonly tool: string; readonly api: ToolExecutionApi },
		run: () => Promise<T>,
		context: Context,
	) => Promise<T>;
}

const NOOP_LOGGER: FlueLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Memo key of one `step.do(name)`; namespaced so tool memos never collide with Pi's. */
const stepMemoKey = (name: string) => `flue.step:${name}`;

/** A durable `step` backed by Pi task memos: first recorded value wins, reruns replay it. */
function createMemoStep(toolName: string, api: ToolExecutionApi, context: Context): ToolStep {
	const used = new Set<string>();
	return {
		async do(name, fn) {
			const stepName = claimStepName(name, toolName, used);
			const key = stepMemoKey(stepName);
			type Recorded = { defined: boolean; value: JsonValue };
			const recorded = await api.memo<Recorded>(key, context);
			if (recorded !== undefined) return (recorded.defined ? recorded.value : undefined) as never;
			const value = cloneStepValue(await fn(), toolName, stepName);
			const winner = await api.memo<Recorded>(
				key,
				value === undefined
					? { defined: false, value: null }
					: { defined: true, value: value as JsonValue },
				context,
			);
			return (winner.defined ? winner.value : undefined) as never;
		},
	};
}

const EMPTY_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false };

/** Convert one Flue `ToolDefinition` into a Pi `ToolRegistration`. */
export function flueToolRegistration(
	tool: ToolDefinition,
	deps: FlueToolDeps = {},
): ToolRegistration {
	const prepared = getPreparedToolAdapter(tool);
	if (!prepared) assertToolDefinition(tool, `Tool "${tool.name}"`);
	const parameters = (prepared?.parameters ??
		(tool.input ? valibotToJsonSchema(tool.input) : EMPTY_PARAMETERS)) as unknown as TSchema;
	const source = getMcpToolSource(tool);
	// An MCP tool can park on a question (`input_required`); see executeMcpTool.
	const asks = prepared !== undefined && source?.resume !== undefined;
	const registration: ToolRegistration = {
		name: tool.name,
		description: tool.description,
		parameters,
		// Durable tools route every side effect through `step.do`, so an
		// interrupted call may rerun; an MCP tool reruns only to continue a
		// parked question; everything else settles as interrupted.
		replay: tool.durable || asks ? 'safe' : 'unsafe',
		async execute(args, api, context): Promise<ToolExecutionResult> {
			const plain = () => executeFlueTool(tool, prepared, deps, args as JsonValue, api, context);
			const run =
				asks && source
					? () =>
							runInQuestionCall({ api, context }, () =>
								executeMcpTool(tool.name, source, plain, api, context),
							)
					: plain;
			return deps.around ? deps.around({ tool: tool.name, api }, run, context) : run();
		},
	};
	// Code Mode reaches an MCP tool's server through its registration.
	if (source) registerMcpToolSource(registration, source);
	return registration;
}

/**
 * An MCP tool call that may park on an `input_required` question
 * (`pi/questions.ts`): a first run runs; a rerun of a call parked on a
 * question continues it — the answer, then the request again with the
 * answers and the server's `requestState`; any other rerun settles as
 * interrupted, as `replay: "unsafe"` would.
 */
async function executeMcpTool(
	name: string,
	source: McpToolSource,
	run: () => Promise<ToolExecutionResult>,
	api: ToolExecutionApi,
	context: Context,
): Promise<ToolExecutionResult> {
	const begun = await beginQuestionableCall(api, context);
	if (begun.kind === 'first') return run();
	if (begun.kind === 'resume' && begun.question.kind === 'mcp-input' && source.resume) {
		const result = await source.resume(begun.question, context.abortSignal);
		return {
			content: mcpToolOutput(name, result).map((block) =>
				block.type === 'text'
					? { type: 'text' as const, text: block.text }
					: { type: 'image' as const, data: block.data, mimeType: block.mimeType },
			),
			details: { customTool: name },
		};
	}
	if (begun.question) await cancelQuestion(api, begun.question.id, Date.now(), context);
	return {
		content: [
			{
				type: 'text',
				text: `Tool ${name} was interrupted (the agent restarted) and may have partly run.`,
			},
		],
		isError: true,
	};
}

async function executeFlueTool(
	tool: ToolDefinition,
	prepared: ReturnType<typeof getPreparedToolAdapter>,
	deps: FlueToolDeps,
	args: JsonValue,
	api: ToolExecutionApi,
	context: Context,
): Promise<ToolExecutionResult> {
	const { mergedSignal } = composeTimeoutSignal(tool.timeoutMs, context.abortSignal);
	if (prepared) {
		const output = await prepared.execute(args as Record<string, unknown>, mergedSignal);
		return {
			content:
				typeof output === 'string'
					? [{ type: 'text', text: output }]
					: output.map((block) =>
							block.type === 'text'
								? { type: 'text' as const, text: block.text }
								: { type: 'image' as const, data: block.data, mimeType: block.mimeType },
						),
			details: { customTool: tool.name },
		};
	}
	const log = deps.logger?.(tool.name, api.callId) ?? NOOP_LOGGER;
	const parsed = parseToolInput(tool, args, mergedSignal, {
		log,
		toolCallId: api.callId,
		...(tool.durable ? { step: createMemoStep(tool.name, api, context) } : {}),
	});
	let scope: FlueToolHarnessScope | undefined;
	if (tool.harness) {
		if (!deps.harness) {
			throw new Error(
				`[flue] Tool "${tool.name}" declares \`harness: true\`, but this host has no harness binding.`,
			);
		}
		scope = await deps.harness({ tool: tool.name, api, signal: mergedSignal }, context);
	}
	try {
		const runContext = scope
			? ({ ...parsed.context, harness: scope.harness } as unknown as typeof parsed.context)
			: parsed.context;
		const resolved = resolveToolRun(
			tool,
			await raceToolWithDeadline(
				() => tool.run(runContext),
				mergedSignal,
				tool.timeoutMs,
				tool.name,
			),
		);
		const output = resolved.output as JsonValue | undefined;
		return {
			content: [{ type: 'text', text: output === undefined ? 'null' : JSON.stringify(output) }],
			details: { customTool: tool.name, ...(output !== undefined ? { output } : {}) },
			...(resolved.terminate ? { control: { terminate: true } } : {}),
		};
	} finally {
		await scope?.close();
	}
}

/**
 * Re-register a pi-agent-core `AgentTool` (Flue's `grep`/`glob`, skill
 * resources) as a Pi tool. Its abort signal is the invocation's context
 * signal; `terminate` maps onto the Pi control.
 */
export function agentToolRegistration(
	tool: AgentTool<any>,
	options: { readonly replay?: 'safe' | 'unsafe'; readonly executionMode?: ToolExecutionMode } = {},
): ToolRegistration {
	const executionMode =
		options.executionMode ??
		(tool as AgentTool<any> & { executionMode?: ToolExecutionMode }).executionMode;
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(options.replay !== undefined ? { replay: options.replay } : {}),
		...(executionMode !== undefined ? { executionMode } : {}),
		async execute(args, api, context) {
			const result: AgentToolResult<unknown> = await tool.execute(
				api.callId,
				args,
				context.abortSignal,
			);
			return {
				content: result.content,
				...(result.details !== undefined ? { details: result.details as JsonValue } : {}),
				...(result.isError ? { isError: true } : {}),
				...(result.usage !== undefined ? { usage: result.usage } : {}),
				...(result.terminate ? { control: { terminate: true } } : {}),
			};
		},
	};
}

/** Names of the sandbox-backed tools, in offered order. */
export const SANDBOX_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'grep', 'glob'] as const;

/**
 * The standard sandbox tool set. `read`/`write`/`edit`/`bash` are Pi's and
 * run over `api.env` — the Harness `env`, which the host builds with
 * `executionEnvFromSandbox` over the same sandbox. `grep`/`glob` are Flue's
 * over `sandbox`. Pure reads (`read`, `grep`, `glob`) are replay-safe.
 */
export function sandboxToolRegistrations(sandbox: Sandbox): ToolRegistration[] {
	return [
		{ ...createReadTool(), replay: 'safe' },
		createWriteTool(),
		createEditTool(),
		createBashTool(),
		agentToolRegistration(createGrepTool(sandbox), { replay: 'safe' }),
		agentToolRegistration(createGlobTool(sandbox), { replay: 'safe' }),
	];
}

/** Structured-result tool details as `resultFromToolDetails` reads them back. */
export type ResultToolDetails =
	| { readonly tool: typeof FINISH_TOOL_NAME; readonly result: JsonValue }
	| { readonly tool: typeof GIVE_UP_TOOL_NAME; readonly reason: string };

/**
 * `finish`/`give_up` for a `result` schema as Pi tools with `control:
 * terminate`. Pi ends the run only when every call of the round terminates,
 * the same batch rule Flue's engine used. First-wins is not needed across
 * calls: the settlement reads the first accepted result in the round.
 */
export function resultToolRegistrations(schema: v.GenericSchema): ToolRegistration[] {
	const bundle = createResultTools(schema);
	return bundle.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		async execute(args, api, context) {
			// A fresh bundle per call keeps first-wins state out of process memory,
			// so a rerun after recovery validates exactly like the first attempt.
			const fresh = createResultTools(schema).tools.find((each) => each.name === tool.name);
			if (!fresh) throw new Error(`[flue] invariant: result tool "${tool.name}" disappeared.`);
			const result = await fresh.execute(api.callId, args, context.abortSignal);
			return {
				content: result.content,
				details: result.details as JsonValue,
				...(result.terminate ? { control: { terminate: true } } : {}),
			};
		},
	}));
}

/** Read the structured outcome a result tool recorded in its tool-result `details`. */
export function resultFromToolDetails(
	details: unknown,
): { type: 'finished'; value: JsonValue } | { type: 'gave_up'; reason: string } | undefined {
	if (typeof details !== 'object' || details === null) return undefined;
	const record = details as Record<string, unknown>;
	if (record.tool === FINISH_TOOL_NAME && 'result' in record) {
		return { type: 'finished', value: record.result as JsonValue };
	}
	if (record.tool === GIVE_UP_TOOL_NAME && typeof record.reason === 'string') {
		return { type: 'gave_up', reason: record.reason };
	}
	return undefined;
}
