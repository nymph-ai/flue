/**
 * Scripted agents for the conversation-projection golden tests
 * (PI_UPGRADE_PLAN.md §7 step 7). Every scenario uses only the public
 * authoring and client surface (`'use agent'` hooks, `init()`), so the same
 * definitions run on the legacy loop (where the fixtures were recorded) and
 * on the Pi Durable host (where `golden.test.ts` compares against them).
 *
 * The model is pi-ai's faux provider. Responses are factories that route on
 * the request, never on call order, so a runtime that makes a different
 * number of model calls (compaction summaries, result retries) still gets
 * the same answers.
 */
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Message,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import type { AgentInstanceHandle } from '../agent-client.ts';
import {
	defineTool,
	useDataWriter,
	useModel,
	useResponseFinish,
	useResponseStart,
	useTool,
} from '../index.ts';
import type { Agent } from '../types.ts';

export interface ScenarioRun {
	/** Replies (or failures) of every read the driver made, in order. */
	readonly replies: unknown[];
}

export interface GoldenScenario {
	readonly name: string;
	readonly agent: Agent;
	/** Faux model definitions (id `model` unless a scenario needs limits). */
	readonly models?: Parameters<typeof fauxProvider>[0];
	readonly respond: (messages: readonly Message[]) => AssistantMessage;
	drive(handle: AgentInstanceHandle): Promise<ScenarioRun>;
}

/** Text of a message's text blocks. */
function textOf(message: Message | undefined): string {
	if (!message) return '';
	const content = (message as { content?: unknown }).content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.flatMap((part: { type?: string; text?: string }) =>
			part.type === 'text' && part.text ? [part.text] : [],
		)
		.join('');
}

function lastNonSystem(messages: readonly Message[]): Message | undefined {
	return [...messages].reverse().find((message) => (message.role as string) !== 'system');
}

function allText(messages: readonly Message[]): string {
	return messages.map((message) => textOf(message)).join('\n');
}

async function settle(
	handle: AgentInstanceHandle,
	receipt: Awaited<ReturnType<AgentInstanceHandle['dispatch']>>,
) {
	try {
		const reply = await handle.read(receipt);
		return { ok: true, text: reply.text, data: reply.data, metadata: reply.metadata ?? null };
	} catch (error) {
		return {
			ok: false,
			name: (error as Error).name,
			outcome: (error as { outcome?: string }).outcome ?? null,
		};
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (!signal) return;
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
	fauxAssistantMessage(calls, { stopReason: 'toolUse' });

// ─── plain answer ────────────────────────────────────────────────────────────

function PlainAnswer() {
	useModel('faux/model');
	return 'You are terse.';
}

// ─── streamed deltas (reasoning + text) ─────────────────────────────────────

function StreamedDeltas() {
	useModel('faux/model');
	return 'Explain your reasoning.';
}

// ─── tool calls, including a failing one ────────────────────────────────────

const lookup = defineTool({
	name: 'lookup',
	description: 'Look up a value by key.',
	input: v.object({ key: v.string() }),
	output: v.object({ value: v.string() }),
	run: ({ data }) => ({ value: data.key.toUpperCase() }),
});

const explode = defineTool({
	name: 'explode',
	description: 'Always fails.',
	run: () => {
		throw new Error('kaboom');
	},
});

function ToolCalls() {
	useModel('faux/model');
	useTool(lookup);
	useTool(explode);
	return 'Use the tools you are given.';
}

// ─── structured result through a harness prompt ─────────────────────────────

const classify = defineTool({
	name: 'classify',
	description: 'Classify the message with a structured sub-prompt.',
	harness: true,
	output: v.object({ label: v.picklist(['spam', 'ham']) }),
	async run({ harness }) {
		const response = await harness.prompt('Classify the message as spam or ham.', {
			result: v.object({ label: v.picklist(['spam', 'ham']) }),
		});
		return response.data;
	},
});

function StructuredResult() {
	useModel('faux/model');
	useTool(classify);
	return 'Classify incoming messages with the classify tool.';
}

// ─── data parts and response metadata ───────────────────────────────────────

function DataAndMetadata() {
	useModel('faux/model');
	const writeProgress = useDataWriter('progress', { schema: v.object({ step: v.number() }) });
	useResponseStart(() => ({ channel: 'golden' }));
	useResponseFinish(({ response }) => ({ toolCalls: response.toolCalls.length }));
	useTool(
		defineTool({
			name: 'work',
			description: 'Do a unit of work and report progress.',
			run: () => {
				writeProgress({ step: 1 });
				writeProgress({ step: 2 });
				return 'worked';
			},
		}),
	);
	return 'Work, then answer.';
}

// ─── threshold compaction ───────────────────────────────────────────────────

function Compaction() {
	useModel('faux/small', { compaction: { reserveTokens: 200, keepRecentTokens: 120 } });
	return 'Answer each question at length.';
}

const LONG_ANSWER = `${'This is a deliberately long answer that fills the context window. '.repeat(20)}`;

// ─── abort ──────────────────────────────────────────────────────────────────

const abortStarted = { current: deferred() };

const blockUntilAborted = defineTool({
	name: 'block',
	description: 'Blocks until the run is aborted.',
	async run({ signal }) {
		abortStarted.current.resolve();
		return await waitForAbort(signal);
	},
});

function Abort() {
	useModel('faux/model');
	useTool(blockUntilAborted);
	return 'Call block.';
}

// ─── join / steer ───────────────────────────────────────────────────────────

const joinGate = { started: deferred(), open: deferred() };

const waitGate = defineTool({
	name: 'wait_gate',
	description: 'Wait for the gate to open.',
	async run() {
		joinGate.started.resolve();
		await joinGate.open.promise;
		return 'gate open';
	},
});

function JoinSteer() {
	useModel('faux/model');
	useTool(waitGate);
	return 'Call wait_gate first.';
}

// ─── signal delivery ────────────────────────────────────────────────────────

function SignalDelivery() {
	useModel('faux/model');
	return 'React to signals.';
}

export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
	{
		name: 'plain-answer',
		agent: PlainAnswer,
		respond: () => fauxAssistantMessage('Hello there.'),
		async drive(handle) {
			const receipt = await handle.dispatch('Hi');
			return { replies: [await settle(handle, receipt)] };
		},
	},
	{
		name: 'streamed-deltas',
		agent: StreamedDeltas,
		models: { models: [{ id: 'model', reasoning: true }], tokenSize: { min: 2, max: 2 } },
		respond: () =>
			fauxAssistantMessage([
				fauxThinking('Let me think about the question carefully before answering.'),
				fauxText(
					'The answer is forty-two, and this explanation streams in as many small deltas as it can.',
				),
			]),
		async drive(handle) {
			const receipt = await handle.dispatch('What is the answer?');
			return { replies: [await settle(handle, receipt)] };
		},
	},
	{
		name: 'tool-calls',
		agent: ToolCalls,
		respond: (messages) => {
			const last = lastNonSystem(messages);
			if (last?.role === 'toolResult')
				return fauxAssistantMessage('Done: ABC, and explode failed.');
			return toolUse(
				fauxToolCall('lookup', { key: 'abc' }, { id: 'call_lookup' }),
				fauxToolCall('explode', {}, { id: 'call_explode' }),
			);
		},
		async drive(handle) {
			const receipt = await handle.dispatch('Look up abc and explode.');
			return { replies: [await settle(handle, receipt)] };
		},
	},
	{
		name: 'structured-result',
		agent: StructuredResult,
		respond: (messages) => {
			const last = lastNonSystem(messages);
			const text = allText(messages);
			if (text.includes('Classify the message as spam or ham.')) {
				return toolUse(fauxToolCall('finish', { label: 'spam' }, { id: 'call_finish' }));
			}
			if (last?.role === 'toolResult') return fauxAssistantMessage('Classified as spam.');
			return toolUse(fauxToolCall('classify', {}, { id: 'call_classify' }));
		},
		async drive(handle) {
			const receipt = await handle.dispatch('Buy cheap watches now!!!');
			return { replies: [await settle(handle, receipt)] };
		},
	},
	{
		name: 'data-and-metadata',
		agent: DataAndMetadata,
		respond: (messages) => {
			const last = lastNonSystem(messages);
			if (last?.role === 'toolResult') return fauxAssistantMessage('All work done.');
			return toolUse(fauxToolCall('work', {}, { id: 'call_work' }));
		},
		async drive(handle) {
			const receipt = await handle.dispatch('Do the work.');
			return { replies: [await settle(handle, receipt)] };
		},
	},
	{
		name: 'compaction',
		agent: Compaction,
		models: { models: [{ id: 'small', contextWindow: 1200, maxTokens: 200 }] },
		respond: (messages) => {
			// Summarization requests end with the summarizer's instructions.
			if (/summar/i.test(textOf(lastNonSystem(messages)))) {
				return fauxAssistantMessage('Summary: the user asked three questions.');
			}
			return fauxAssistantMessage(LONG_ANSWER);
		},
		async drive(handle) {
			const replies: unknown[] = [];
			for (const question of ['First question?', 'Second question?', 'Third question?']) {
				replies.push(await settle(handle, await handle.dispatch(question)));
			}
			return { replies };
		},
	},
	{
		name: 'abort',
		agent: Abort,
		respond: () => toolUse(fauxToolCall('block', {}, { id: 'call_block' })),
		async drive(handle) {
			abortStarted.current = deferred();
			const receipt = await handle.dispatch('Block please.');
			await abortStarted.current.promise;
			await handle.abort();
			return { replies: [await settle(handle, receipt)] };
		},
	},
	{
		name: 'join-steer',
		agent: JoinSteer,
		respond: (messages) => {
			const last = lastNonSystem(messages);
			if (last?.role === 'user' && textOf(last).includes('Second'))
				return fauxAssistantMessage('Both handled.');
			if (last?.role === 'toolResult') return fauxAssistantMessage('Both handled.');
			return toolUse(fauxToolCall('wait_gate', {}, { id: 'call_gate' }));
		},
		async drive(handle) {
			joinGate.started = deferred();
			joinGate.open = deferred();
			const first = await handle.dispatch('First message.');
			await joinGate.started.promise;
			const second = await handle.dispatch('Second message.');
			joinGate.open.resolve();
			return { replies: [await settle(handle, first), await settle(handle, second)] };
		},
	},
	{
		name: 'signal-delivery',
		agent: SignalDelivery,
		respond: () => fauxAssistantMessage('Noted the alert.'),
		async drive(handle) {
			const receipt = await handle.dispatch({
				message: {
					kind: 'signal',
					type: 'monitor.alert',
					body: 'Disk usage is at 95%.',
					attributes: { severity: 'high' },
					tagName: 'alert',
				},
			});
			return { replies: [await settle(handle, receipt)] };
		},
	},
];

/** Register a scenario's faux provider responses: every request routes through `respond`. */
export function scenarioProvider(scenario: GoldenScenario): ReturnType<typeof fauxProvider> {
	const faux = fauxProvider(scenario.models ?? { models: [{ id: 'model' }] });
	faux.setResponses(
		Array.from(
			{ length: 64 },
			() => (context: { messages: Message[] }) => scenario.respond(context.messages),
		),
	);
	return faux;
}
