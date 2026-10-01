/**
 * Agents' Durable Objects exactly as a generated Cloudflare entry builds
 * them (`@flue/vite` `cloudflare-entry.ts`): `createFlueAgentClass` over
 * `DurableObject` and the Agents SDK's `Lifecycle`, the shared
 * `createCloudflareAgentRuntime`, and entity streams on an Electric server —
 * here `FakeDurableStreamsServer`, in the isolate. The model is pi-ai's faux
 * provider, streaming at the society's scripted rate, so a turn commits the
 * partials a live one does.
 *
 * - `bob` (`FirstWakeAgent`): the society's plain agent.
 * - `carol` (`RowsAgent`): tools — `probe`, and `send`, which needs approval
 *   inside Code Mode — and Code Mode, whose scripts run in the object's isolate.
 *
 * Their storage is traced (`sql-trace.ts`) from before the class constructor
 * runs, so a test sees every row an entity's wakes cost.
 *
 * Imported only by `*.workers.test.ts`.
 */
import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
} from '@earendil-works/pi-ai';
import { createFlueContext } from '../../client.ts';
import { useCodeMode } from '../../hooks/use-code-mode.ts';
import { useModel } from '../../hooks/use-model.ts';
import { useTool } from '../../hooks/use-tool.ts';
import { resolveModel, setProvider } from '../../runtime/providers.ts';
import { electricStreams, setStreams } from '../../runtime/streams-config.ts';
import { FakeDurableStreamsServer } from '../../streams/fake-durable-streams-server.ts';
import type { Agent as FlueAgent } from '../../types.ts';
import { createCloudflareAgentRuntime } from '../agent-coordinator.ts';
import { runWithCloudflareContext } from '../context.ts';
import { createFlueAgentClass } from '../flue-agent-class.ts';
import { installSqlTrace, sqlTrace } from './sql-trace.ts';

/** The society's scripted model streams 50 tokens a second. */
const TOKENS_PER_SECOND = 50;

/** ~60 partials: 300 four-character tokens at 50 tokens a second, a partial every 100 ms. */
export const STREAMED_TEXT = 'abcd'.repeat(300);
export const STORE_CODE = "const n = load('k') ?? 0; store('k', n + 1); return n + 1;";
export const APPROVAL_CODE = "await tools.send({}); return 'sent';";

/** How many times carol's `send` tool really ran (module state survives an eviction in tests). */
export const sends = { count: 0 };

function textOf(message: Message | undefined): string {
	if (!message) return '';
	if (typeof message.content === 'string') return message.content;
	return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function respond(messages: readonly Message[]) {
	const userIndex = messages.findLastIndex((message) => message.role === 'user');
	const text = textOf(messages[userIndex]);
	const results = messages.slice(userIndex + 1).filter((message) => message.role === 'toolResult');
	if (results.length > 0) return fauxAssistantMessage([fauxText('done')]);
	const tools = /tools (\d+)/.exec(text);
	if (tools) {
		return fauxAssistantMessage(
			Array.from({ length: Number(tools[1]) }, (_, index) =>
				fauxToolCall('probe', {}, { id: `probe_${index}` }),
			),
			{ stopReason: 'toolUse' },
		);
	}
	if (/store it/.test(text))
		return fauxAssistantMessage([fauxToolCall('codemode', { code: STORE_CODE })], {
			stopReason: 'toolUse',
		});
	if (/approve it/.test(text))
		return fauxAssistantMessage([fauxToolCall('codemode', { code: APPROVAL_CODE })], {
			stopReason: 'toolUse',
		});
	if (/stream/.test(text)) return fauxAssistantMessage([fauxText(STREAMED_TEXT)]);
	return fauxAssistantMessage('Spawned and ready.');
}

const faux = fauxProvider({
	provider: 'faux',
	models: [{ id: 'm' }],
	tokensPerSecond: TOKENS_PER_SECOND,
	tokenSize: { min: 4, max: 4 },
});
faux.setResponses(
	Array.from(
		{ length: 2000 },
		() => (request: { messages: Message[] }) => respond(request.messages),
	) as never,
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

const Carol = (() => {
	useModel('faux/m');
	useTool({ name: 'probe', description: 'Probe.', run: () => 'ok' });
	useTool({
		name: 'send',
		description: 'Send.',
		run: () => {
			sends.count++;
			return 'sent';
		},
	});
	useCodeMode({ requiresApproval: ['send'] });
	return 'You are Carol, a member of a small society of agents.';
}) as unknown as FlueAgent;

const identities: Record<string, { bindingName: string; className: string }> = {
	bob: { bindingName: 'FIRST_WAKE', className: 'FirstWakeAgent' },
	carol: { bindingName: 'ROWS', className: 'RowsAgent' },
};

const runtime = createCloudflareAgentRuntime({
	agents: [
		{ name: 'bob', agent: Bob },
		{ name: 'carol', agent: Carol },
	],
	createContext: ({ instance, agentName, request, submissionId }) =>
		createFlueContext({
			id: instance.name,
			agentName,
			env: instance.env ?? {},
			req: request,
			...(submissionId === undefined ? {} : { submissionId }),
			agentConfig: { resolveModel },
		}),
	runWithInstanceContext: (instance, agentName, callback) =>
		runWithCloudflareContext(
			{
				env: instance.env,
				storage: instance.ctx.storage as never,
				durableObjectIdentity: {
					...(identities[agentName] as { bindingName: string; className: string }),
					name: instance.name,
					id: instance.ctx.id.toString(),
				},
				durableObjectState: instance.ctx as never,
			},
			callback,
		),
});

const Bobs = createFlueAgentClass({
	DurableObject,
	Lifecycle,
	runtime,
	className: 'FirstWakeAgent',
	agentName: 'bob',
});

const Carols = createFlueAgentClass({
	DurableObject,
	Lifecycle,
	runtime,
	className: 'RowsAgent',
	agentName: 'carol',
});

export class FirstWakeAgent extends Bobs {
	constructor(ctx: DurableObjectState, env: unknown) {
		installSqlTrace(ctx.storage);
		super(ctx, env);
	}
}

export class RowsAgent extends Carols {
	constructor(ctx: DurableObjectState, env: unknown) {
		installSqlTrace(ctx.storage);
		super(ctx, env);
	}
}

/** A stub addressed by name; constructing the object waits for its first call. */
export function stubFor(
	namespace: DurableObjectNamespace,
	name: string,
): Promise<DurableObjectStub> {
	return Promise.resolve(namespace.getByName(name));
}

/** Arm a wake a minute out on `instance` (an idle wake once made due). */
export async function armLaterWake(instance: unknown): Promise<void> {
	const storage = (instance as { ctx: DurableObjectState }).ctx.storage;
	const at = Date.now() + 60_000;
	if (((await storage.getAlarm()) ?? Number.POSITIVE_INFINITY) > at) await storage.setAlarm(at);
}

/** Make the armed wake due now (unrecorded); `false` when none is armed. */
export async function makeWakesDue(state: DurableObjectState): Promise<boolean> {
	if ((await state.storage.getAlarm()) === null) return false;
	await sqlTrace.unrecorded(() => state.storage.setAlarm(Date.now()));
	return true;
}
