import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { init, useAgentStart, useModel, usePersistentState, useSandbox } from './index.ts';
import { local, start } from './node/index.ts';
import { readConversation, toolParts } from './runtime/conversation-test-support.ts';

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
	if (!signal) throw new Error('Expected the tool to receive an abort signal.');
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

it('aborts a sequential tool round mid-call: the rest never runs, its state write never lands', async () => {
	const firstStarted = Promise.withResolvers<void>();
	const calls = { first: 0, second: 0 };
	function AbortBatch() {
		useModel('faux/model');
		const [phase, setPhase] = usePersistentState('phase', 'initial');
		useAgentStart(() => setPhase('started'));
		useSandbox({
			...local(),
			tools: () => [
				{
					name: 'first',
					label: 'First',
					description: 'Wait for the test to abort the session.',
					parameters: { type: 'object', properties: {} },
					executionMode: 'sequential',
					async execute(_id, _args, signal) {
						calls.first += 1;
						setPhase('must-not-commit');
						firstStarted.resolve();
						return await waitForAbort(signal);
					},
				},
				{
					name: 'second',
					label: 'Second',
					description: 'Must not run after the abort.',
					parameters: { type: 'object', properties: {} },
					async execute() {
						calls.second += 1;
						return { details: {}, content: [{ type: 'text' as const, text: 'second result' }] };
					},
				},
			],
		});
		return `Run the supplied tool calls. Phase: ${String(phase)}.`;
	}

	const requests: string[] = [];
	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall('first', {}, { id: 'call_first' }),
				fauxToolCall('second', {}, { id: 'call_second' }),
			],
			{
				stopReason: 'toolUse',
			},
		),
		(context: { messages: Message[] }) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage('Recovered.');
		},
	]);
	const runtime = await start({ agents: [AbortBatch], providers: [faux.provider], env: {} });
	const agent = init(AbortBatch, { id: 'abort-partial-batch' });

	try {
		const receipt = await agent.dispatch('Run both tools.');
		await firstStarted.promise;
		await agent.abort();
		await expect(agent.read(receipt)).rejects.toMatchObject({
			name: 'AgentRunError',
			message: expect.stringMatching(/aborted/i),
		});
		expect(calls).toEqual({ first: 1, second: 0 });

		// Both calls settle as errors in the public conversation, and the
		// terminal advisory marks the submission aborted.
		const snapshot = await readConversation(AbortBatch, 'abort-partial-batch');
		expect(toolParts(snapshot).map((part) => [part.toolCallId, part.state])).toEqual([
			['call_first', 'output-error'],
			['call_second', 'output-error'],
		]);
		expect(snapshot.messages.find((message) => message.settlement !== undefined)).toMatchObject({
			role: 'system',
			purpose: 'advisory',
			settlement: { outcome: 'aborted' },
		});
		expect(snapshot.settlements).toMatchObject([
			{ submissionId: receipt.submissionId, outcome: 'aborted' },
		]);

		// The next delivery runs normally, and sees the state the lifecycle
		// callback committed — not the aborted tool's write.
		await expect(agent.read(await agent.dispatch('Continue.'))).resolves.toMatchObject({
			text: 'Recovered.',
		});
		expect(requests.at(-1)).toContain('Phase: started.');
		expect(requests.join('')).not.toContain('must-not-commit');
	} finally {
		await agent.abort();
		await runtime.stop();
	}
});
