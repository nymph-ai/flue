import { fauxAssistantMessage, fauxProvider, fauxText, type Message } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { init, instrument, useModel } from './index.ts';
import { sqlite, start } from './node/index.ts';
import type { FlueObservation } from './types.ts';

const longMessage = 'x'.repeat(70_000);

/** Whether a request is a compaction summarization (it ends with the summarizer's instructions). */
function isSummaryRequest(messages: readonly Message[]): boolean {
	const last = messages.at(-1);
	const content = last?.role === 'user' ? last.content : undefined;
	const text =
		typeof content === 'string'
			? content
			: (content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
	return /summar/i.test(text);
}

it('settles a completed response after silent-overflow compaction', async () => {
	function OverflowAgent() {
		useModel('faux/model', { compaction: false });
		return 'Reply to the user.';
	}

	const faux = fauxProvider({
		models: [{ id: 'model', contextWindow: 32_768, maxTokens: 4_096 }],
	});
	// Routed on the request, not call order: Pi compacts a context that no
	// longer fits before it asks for the response, where the legacy loop
	// asked first and compacted after.
	let answers = 0;
	faux.setResponses(
		Array.from({ length: 8 }, () => (context: { messages: Message[] }) => {
			if (isSummaryRequest(context.messages)) {
				return fauxAssistantMessage([fauxText('Conversation summary.')], { stopReason: 'stop' });
			}
			answers += 1;
			return fauxAssistantMessage(
				[fauxText(answers === 1 ? 'First response.' : 'Completed response.')],
				{
					stopReason: 'stop',
				},
			);
		}),
	);
	const observations: FlueObservation[] = [];
	const disposeInstrumentation = instrument({
		dispose() {},
		observe(event) {
			observations.push(event);
		},
		interceptor(_operation, _context, next) {
			return next();
		},
	});
	const runtime = await start({
		agents: [OverflowAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(OverflowAgent, { id: 'completed-overflow' });

	try {
		await agent.read(await agent.dispatch(longMessage));
		await expect(agent.read(await agent.dispatch(longMessage))).resolves.toMatchObject({
			text: 'Completed response.',
		});
		expect(faux.state.callCount).toBe(3);
		expect(observations.some((event) => event.type === 'compaction' && !event.isError)).toBe(true);
	} finally {
		await agent.abort();
		await runtime.stop();
		await disposeInstrumentation();
	}
});

it('still retries error-based overflow after compaction', async () => {
	function OverflowAgent() {
		useModel('faux/model', { compaction: false });
		return 'Reply to the user.';
	}

	const faux = fauxProvider({
		models: [{ id: 'model', contextWindow: 32_768, maxTokens: 4_096 }],
	});
	// The context fits the window, so only the provider's overflow error can
	// trigger the compaction; the request after it is answered.
	let calls = 0;
	faux.setResponses(
		Array.from({ length: 8 }, () => (context: { messages: Message[] }) => {
			calls += 1;
			if (isSummaryRequest(context.messages)) {
				return fauxAssistantMessage([fauxText('Conversation summary.')], { stopReason: 'stop' });
			}
			if (calls === 1)
				return fauxAssistantMessage([fauxText('First response.')], { stopReason: 'stop' });
			if (calls === 2) {
				return fauxAssistantMessage([], {
					stopReason: 'error',
					errorMessage: 'Request exceeds the context window.',
				});
			}
			return fauxAssistantMessage([fauxText('Recovered response.')], { stopReason: 'stop' });
		}),
	);
	const runtime = await start({
		agents: [OverflowAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(OverflowAgent, { id: 'error-overflow' });
	const fitting = 'x'.repeat(40_000);

	try {
		await agent.read(await agent.dispatch(fitting));
		await expect(agent.read(await agent.dispatch(fitting))).resolves.toMatchObject({
			text: 'Recovered response.',
		});
		expect(faux.state.callCount).toBe(4);
	} finally {
		await agent.abort();
		await runtime.stop();
	}
});
