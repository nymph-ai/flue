/**
 * An agent's Durable Object as a generated Cloudflare entry builds it, like
 * `first-wake.ts`, for an agent that uses Code Mode over an in-isolate MCP
 * server (`notes-server.ts`, 40 notes). The model is pi-ai's faux provider,
 * scripted by the inbox message's text:
 *
 * - `ten calls` — one `codemode` call whose script makes 10 MCP calls;
 * - `store it` — one `codemode` call whose script reads and writes `store`;
 * - `classify` — {@link CLASSIFY_SCRIPT}: every note through a classifier
 *   from four concurrent workers, the results stored;
 * - `recall` — a script returning how many results that one stored;
 * - anything else — a short answer.
 *
 * Every tool result the model sees is kept in {@link toolResults}. A faux
 * classifier is registered as `faux-jev/jev`: it answers a choice question
 * from the state's text, which `notes-server.ts` marks `[mild]` or `[high]`.
 *
 * Its storage is traced (`sql-trace.ts`) from before the class constructor
 * runs. It shares `first-wake.ts`'s Durable Streams server: the streams
 * configuration is one per isolate. Imported only by `*.workers.test.ts`.
 */
import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
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
import { notes, notesServer, type Tone } from './notes-server.ts';
import { installSqlTrace } from './sql-trace.ts';

/** Ten MCP calls in one script. */
export const TEN_CALLS_SCRIPT =
	'let n = 0; for (let i = 1; i <= 10; i++) { const r = await tools.mcp__notes__get_note({ id: "N-" + i }); n += r.structuredContent.note ? 1 : 0; } return n;';

/** Pi's classifier pattern: four workers over every note, `Promise.all`, results stored. */
export const CLASSIFY_SCRIPT = `const { notes } = (await tools.mcp__notes__list_notes({})).structuredContent;
const model = await models.getModelOfType("classifier", "faux-jev", "jev");
const questions = {
  frustration: {
    type: "choice",
    instructions: "Judge only the emotional tone.",
    criteria: { none: "Neutral", mild: "Annoyed", high: "Angry" },
  },
};
const results = [];
let next = 0;
async function worker() {
  while (next < notes.length) {
    const item = notes[next++];
    const { note } = (await tools.mcp__notes__get_note({ id: item.id })).structuredContent;
    const c = await models.classify(model, { state: note, questions });
    results.push({ id: item.id, ...c.answers.frustration });
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
store("frustration", results);
const counts = {};
for (const r of results) counts[r.choice] = (counts[r.choice] ?? 0) + 1;
return { total: results.length, counts };`;

/** A read and a write of the conversation's store. */
export const STORE_SCRIPT = "const n = load('k') ?? 0; store('k', n + 1); return n + 1;";

export const NOTES = notes(40);
export const notesMcp = notesServer(NOTES);

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
		id: 'faux-jev',
		name: 'Faux Jev',
		auth: { apiKey: { name: 'Faux', resolve: async () => ({ auth: {} }) } },
		models: [
			{
				type: 'classifier' as const,
				id: 'jev',
				name: 'Jev',
				api: 'typesafe-system-one',
				provider: 'faux-jev',
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
	const code = text.includes('recall')
		? 'return load("frustration").length;'
		: text.includes('ten calls')
			? TEN_CALLS_SCRIPT
			: text.includes('store it')
				? STORE_SCRIPT
				: text.includes('classify')
					? CLASSIFY_SCRIPT
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

const Dora = (() => {
	useModel('faux-codemode/m');
	useMcpConnection({ name: 'notes', url: 'https://notes.test/mcp', fetch: notesMcp.fetch });
	useCodeMode();
	return 'You are Dora. You run scripts.';
}) as unknown as FlueAgent;

const runtime = createCloudflareAgentRuntime({
	agents: [{ name: 'dora', agent: Dora }],
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
	DurableObject,
	Lifecycle,
	runtime,
	className: 'CodemodeTurnAgent',
	agentName: 'dora',
});

export class CodemodeTurnAgent extends Generated {
	constructor(ctx: DurableObjectState, env: unknown) {
		installSqlTrace(ctx.storage);
		super(ctx, env);
	}
}
