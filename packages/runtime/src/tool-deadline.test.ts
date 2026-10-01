import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { init, instrument, useModel, useTool } from './index.ts';
import { start } from './node/index.ts';
import { readConversation, toolParts } from './runtime/conversation-test-support.ts';

function hangUntilSignal(signal: AbortSignal | undefined): Promise<string> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(signal.reason);
		else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

it('settles a tool that exceeds its timeoutMs with a distinguishable error and continues the turn', async () => {
	function SlowAgent() {
		useModel('faux/model');
		useTool({
			name: 'hung',
			description: 'Hangs past its deadline.',
			timeoutMs: 40,
			run: async (context) => hangUntilSignal(context.signal),
		});
		return 'Call the supplied tool.';
	}

	const faux = fauxProvider({ models: [{ id: 'model' }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('hung', {}, { id: 'call_hung' })], {
			stopReason: 'toolUse',
		}),
		fauxAssistantMessage([fauxText('Continuing after the timeout.')], { stopReason: 'stop' }),
	]);
	const disposeInstrumentation = instrument({
		dispose() {},
		observe() {},
		async interceptor(_operation, _context, next) {
			return await next();
		},
	});
	const runtime = await start({
		agents: [SlowAgent],
		providers: [faux.provider],
		env: {},
	});
	const agent = init(SlowAgent, { id: 'tool-timeout' });

	try {
		const receipt = await agent.dispatch('Run the tool.');
		await expect(agent.read(receipt)).resolves.toMatchObject({
			text: 'Continuing after the timeout.',
		});

		// The tool call settled as an error whose text names the deadline —
		// distinguishable from a thrown tool error — and the submission itself
		// did not fail: the turn continued with a follow-up answer.
		const snapshot = await readConversation(SlowAgent, 'tool-timeout');
		const tools = toolParts(snapshot);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			toolCallId: 'call_hung',
			state: 'output-error',
			errorText: expect.stringContaining('Tool "hung" timed out after 40ms'),
		});
		const assistant = snapshot.messages.find((message) => message.role === 'assistant');
		expect(assistant?.parts.at(-1)).toMatchObject({
			type: 'text',
			text: 'Continuing after the timeout.',
		});
	} finally {
		await agent.abort();
		await runtime.stop();
		await disposeInstrumentation();
	}
});
