/**
 * An agent's Durable Object exactly as a generated Cloudflare entry builds it
 * (`@flue/vite` `cloudflare-entry.ts`): `createFlueAgentClass` over the
 * Agents SDK's own `Agent`, the shared `createCloudflareAgentRuntime`, and
 * entity streams on an Electric server — here `FakeDurableStreamsServer`, in
 * the isolate. The model is pi-ai's faux provider, streaming at the society's
 * scripted rate, so a turn commits the partials a live one does.
 *
 * Its storage is traced (`sql-trace.ts`) from before the class constructor
 * runs, so a test sees every row a new entity's first wake costs.
 *
 * Imported only by `*.workers.test.ts`.
 */
import { Agent } from 'agents';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createFlueContext } from '../../client.ts';
import { useModel } from '../../hooks/use-model.ts';
import { resolveModel, setProvider } from '../../runtime/providers.ts';
import { electricStreams, setStreams } from '../../runtime/streams-config.ts';
import { FakeDurableStreamsServer } from '../../streams/fake-durable-streams-server.ts';
import type { Agent as FlueAgent } from '../../types.ts';
import { createCloudflareAgentRuntime } from '../agent-coordinator.ts';
import { runWithCloudflareContext } from '../context.ts';
import { createFlueAgentClass } from '../flue-agent-class.ts';
import { installSqlTrace } from './sql-trace.ts';

/** The society's scripted model streams 50 tokens a second. */
const TOKENS_PER_SECOND = 50;

const faux = fauxProvider({
	provider: 'faux',
	models: [{ id: 'm' }],
	tokensPerSecond: TOKENS_PER_SECOND,
});
faux.setResponses(
	Array.from({ length: 1000 }, () => () => fauxAssistantMessage('Spawned and ready.')) as never,
);
setProvider(faux.provider);

/** Electric, in the isolate: every instance's inbox and events. */
export const streamsServer = new FakeDurableStreamsServer();
export const STREAMS_ROOT = `${streamsServer.origin}/v1/stream`;
setStreams(electricStreams({ baseUrl: STREAMS_ROOT, fetch: streamsServer.fetch }));

const Bob = (() => {
	useModel('faux/m');
	return 'You are Bob, a member of a small society of agents.';
}) as unknown as FlueAgent;

const runtime = createCloudflareAgentRuntime({
	agents: [{ name: 'bob', agent: Bob }],
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
					bindingName: 'FIRST_WAKE',
					className: 'FirstWakeAgent',
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
	className: 'FirstWakeAgent',
	agentName: 'bob',
});

export class FirstWakeAgent extends Generated {
	constructor(ctx: DurableObjectState, env: unknown) {
		installSqlTrace(ctx.storage);
		super(ctx, env);
	}
}
