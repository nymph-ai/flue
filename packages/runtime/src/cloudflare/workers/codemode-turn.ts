/**
 * An agent's Durable Object as a generated Cloudflare entry builds it, like
 * `first-wake.ts`, for an agent that uses Code Mode over an MCP server: the
 * in-isolate `linear` stand-in (`linear-server.ts`). The model is pi-ai's
 * faux provider, scripted by the inbox message's text:
 *
 * - `ten calls` — one `codemode` call whose script makes 10 MCP calls;
 * - `store it` — one `codemode` call whose script reads and writes `store`;
 * - anything else — a short answer.
 *
 * Its storage is traced (`sql-trace.ts`) from before the class constructor
 * runs. It shares `first-wake.ts`'s Durable Streams server: the streams
 * configuration is one per isolate. Imported only by `*.workers.test.ts`.
 */
import { Agent } from 'agents';
import {
	type AssistantMessage,
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
import { linearServer } from './linear-server.ts';
import { installSqlTrace } from './sql-trace.ts';

/** Ten MCP calls in one script. */
export const TEN_CALLS_SCRIPT =
	'async () => { let n = 0; for (let i = 1; i <= 10; i++) { const r = await linear.list_comments({ issueId: "PI-" + i }); n += r.comments.length; } return n; }';

/** A read and a write of the conversation's store. */
export const STORE_SCRIPT =
	"async () => { const n = (await codemode.load('k')) ?? 0; await codemode.store('k', n + 1); return n + 1; }";

export const linear = linearServer();

function lastUserText(context: TranscriptContext): string {
	const user = context.messages.findLast((message) => message.role === 'user');
	if (!user) return '';
	return typeof user.content === 'string'
		? user.content
		: user.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function respond(context: TranscriptContext): AssistantMessage {
	const last = context.messages.at(-1);
	if (last?.role === 'toolResult') return fauxAssistantMessage('Done.');
	const text = lastUserText(context);
	const code = text.includes('ten calls')
		? TEN_CALLS_SCRIPT
		: text.includes('store it')
			? STORE_SCRIPT
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
