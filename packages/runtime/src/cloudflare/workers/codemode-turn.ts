/**
 * An agent's Durable Object as a generated Cloudflare entry builds it, like
 * `first-wake.ts`, for an agent that uses Code Mode over an MCP server: the
 * in-isolate `linear` stand-in (`linear-server.ts`), with 40 open issues. The
 * model is pi-ai's faux provider, scripted by the inbox message's text:
 *
 * - `ten calls` — one `codemode` call whose script makes 10 MCP calls;
 * - `store it` — one `codemode` call whose script reads and writes `store`;
 * - `frustration` — the "You Said No MCP!" script (`you-said-no-mcp.ts`);
 * - `recall` — a script returning how many results that one stored;
 * - anything else — a short answer.
 *
 * Every tool result the model sees is kept in {@link toolResults}. A faux Jev
 * is registered as `cloudflare-workers-ai/typesafe/jev`, the model the
 * post's script names: it answers the frustration question from the
 * comments' text, which `linear-server.ts` marks `[mild]` or `[high]`.
 *
 * Its storage is traced (`sql-trace.ts`) from before the class constructor
 * runs. It shares `first-wake.ts`'s Durable Streams server: the streams
 * configuration is one per isolate. Imported only by `*.workers.test.ts`.
 */
import { Agent } from 'agents';
import {
	type AssistantMessage,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierResult,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type TranscriptContext,
} from '@earendil-works/pi-ai';
import { createFlueContext } from '../../client.ts';
import { useCodeMode } from '../../hooks/use-code-mode.ts';
import { useMcpConnection } from '../../hooks/use-mcp-connection.ts';
import { useModel } from '../../hooks/use-model.ts';
import { resolveModel, setProvider } from '../../runtime/providers.ts';
import type { Agent as FlueAgent } from '../../types.ts';
import { createCloudflareAgentRuntime } from '../agent-coordinator.ts';
import { runWithCloudflareContext } from '../context.ts';
import { createFlueAgentClass } from '../flue-agent-class.ts';
import { linearServer, linearTracker, type Tone } from './linear-server.ts';
import { installSqlTrace } from './sql-trace.ts';
import { FRUSTRATION_SCRIPT } from './you-said-no-mcp.ts';

/** Ten MCP calls in one script. */
export const TEN_CALLS_SCRIPT =
	'let n = 0; for (let i = 1; i <= 10; i++) { const r = await tools.mcp__linear__list_comments({ issueId: "PI-" + i }); n += r.structuredContent.comments.length; } return n;';

/** A read and a write of the conversation's store. */
export const STORE_SCRIPT = "const n = load('k') ?? 0; store('k', n + 1); return n + 1;";

export const linear = linearServer(linearTracker(40));

/** The text of every tool result the model saw, in order. */
export const toolResults: string[] = [];

const PROBABILITIES: Record<Tone, Record<Tone, number>> = {
	none: { none: 0.97, mild: 0.02, high: 0.01 },
	mild: { none: 0.1, mild: 0.85, high: 0.05 },
	high: { none: 0.01, mild: 0.04, high: 0.95 },
};

/** Jev's answer to a choice question, read off the `[mild]`/`[high]` marks in the state. */
setProvider(
	createProvider({
		id: 'cloudflare-workers-ai',
		name: 'Workers AI (faux Jev)',
		auth: { apiKey: { name: 'Faux', resolve: async () => ({ auth: {} }) } },
		models: [
			{
				type: 'classifier' as const,
				id: 'typesafe/jev',
				name: 'Jev',
				api: 'typesafe-system-one',
				provider: 'cloudflare-workers-ai',
				baseUrl: 'https://faux.invalid/',
				input: ['text' as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64_000,
			},
		],
		classifiers: {
			'typesafe-system-one': {
				async classify(
					model: ClassifierModel<ClassifierApi>,
					context: ClassifierContext,
				): Promise<ClassifierResult> {
					const text = JSON.stringify(context.state);
					const tone: Tone = text.includes('[high]')
						? 'high'
						: text.includes('[mild]')
							? 'mild'
							: 'none';
					const answers = Object.fromEntries(
						Object.keys(context.questions).map((key) => [
							key,
							{
								type: 'choice' as const,
								choice: tone,
								probabilities: PROBABILITIES[tone],
								confidence: PROBABILITIES[tone][tone],
							},
						]),
					);
					return {
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers,
						stopReason: 'stop',
						timestamp: Date.now(),
					};
				},
			},
		},
	}),
);

function lastUserText(context: TranscriptContext): string {
	const user = context.messages.findLast((message) => message.role === 'user');
	if (!user) return '';
	return typeof user.content === 'string'
		? user.content
		: user.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function respond(context: TranscriptContext): AssistantMessage {
	const last = context.messages.at(-1);
	if (last?.role === 'toolResult') {
		toolResults.push(
			last.content
				.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
				.join(''),
		);
		return fauxAssistantMessage('Done.');
	}
	const text = lastUserText(context);
	const code = text.includes('ten calls')
		? TEN_CALLS_SCRIPT
		: text.includes('store it')
			? STORE_SCRIPT
			: text.includes('frustration')
				? FRUSTRATION_SCRIPT
				: text.includes('recall')
					? 'return load("frustration").length;'
					: undefined;
	if (code) {
		return fauxAssistantMessage([fauxToolCall('codemode', { code })], { stopReason: 'toolUse' });
	}
	return fauxAssistantMessage('Ready.');
}

const faux = fauxProvider({
	provider: 'faux-codemode',
	models: [{ id: 'm' }],
	tokensPerSecond: 50,
});
faux.setResponses(Array.from({ length: 1000 }, () => respond) as never);
setProvider(faux.provider);

const Carol = (() => {
	useModel('faux-codemode/m');
	useMcpConnection({ name: 'linear', url: 'https://linear.test/mcp', fetch: linear.fetch });
	useCodeMode();
	return 'You are Carol. You run scripts.';
}) as unknown as FlueAgent;

const runtime = createCloudflareAgentRuntime({
	agents: [{ name: 'carol', agent: Carol }],
	createContext: ({ instance, agentName, request, submissionId }) =>
		createFlueContext({
			id: instance.name,
			agentName,
			env: instance.env ?? {},
			req: request,
			...(submissionId === undefined ? {} : { submissionId }),
			agentConfig: { resolveModel },
		}),
	runWithInstanceContext: (instance, _agentName, callback) =>
		runWithCloudflareContext(
			{
				env: instance.env,
				storage: instance.ctx.storage as never,
				durableObjectIdentity: {
					bindingName: 'CODEMODE_TURN',
					className: 'CodemodeTurnAgent',
					name: instance.name,
					id: instance.ctx.id.toString(),
				},
				durableObjectState: instance.ctx as never,
			},
			callback,
		),
});

const Generated = createFlueAgentClass({
	AgentBase: Agent,
	runtime,
	className: 'CodemodeTurnAgent',
	agentName: 'carol',
});

export class CodemodeTurnAgent extends Generated {
	constructor(ctx: DurableObjectState, env: unknown) {
		installSqlTrace(ctx.storage);
		super(ctx, env);
	}
}
