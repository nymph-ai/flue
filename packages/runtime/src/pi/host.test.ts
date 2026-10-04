import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	type AssistantMessage,
	createModels,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
} from '@earendil-works/pi-ai';
import {
	type ConversationId,
	type EntryId,
	type EntryRecord,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type Storage,
} from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	InvalidRequestError,
	SubmissionConflictError,
} from '../errors.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import { defineSkill } from '../skill-definition.ts';
import { defineTool } from '../tool.ts';
import type { AgentRuntimeConfig, SubagentDefinition } from '../types.ts';
import { FlueReceiptIndex } from './docs.ts';
import { createFluePiHost, type FlueAdmission, type FluePiHost } from './host.ts';
import { beginAdmission } from './receipts.ts';
import { type RenderedAgent, renderedAgentFrom } from './registry-bridge.ts';

const context: Context = BACKGROUND_CONTEXT;
const entity = { type: 'assistant', id: 'inst-1' };

/** A storage that survives `Harness.close()`: closing a host then reopening one simulates a crash. */
function durable(storage: MemoryStorage): Storage {
	return new Proxy(storage, {
		get(target, property) {
			if (property === 'close') return async () => {};
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

interface Fixture {
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly storage: MemoryStorage;
	readonly reports: unknown[];
	open(render?: RenderedAgent): Promise<FluePiHost>;
}

function fixture(): Fixture {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = new MemoryStorage();
	const reports: unknown[] = [];
	return {
		faux,
		storage,
		reports,
		async open(render = agent()) {
			const host = createFluePiHost({
				entity,
				models,
				storage: async () => durable(storage),
				onReport: (error) => reports.push(error),
			});
			await host.open(context);
			await host.applyRender(render, context);
			return host;
		},
	};
}

function agent(
	config: Partial<AgentRuntimeConfig> = {},
	lifecycle?: RenderedAgent['lifecycle'],
): RenderedAgent {
	const render = renderedAgentFrom({ model: 'faux/faux-1', ...config });
	return lifecycle ? { ...render, lifecycle } : render;
}

let sequence = 0;
function admission(body: string, overrides: Partial<FlueAdmission> = {}): FlueAdmission {
	return {
		submissionId: `sub_${++sequence}`,
		kind: 'dispatch',
		message: { kind: 'user', body },
		acceptedAt: new Date(1_700_000_000_000 + sequence).toISOString(),
		whenBusy: 'followUp',
		...overrides,
	};
}

function textOf(message: Message | undefined): string {
	if (!message || message.role === 'system') return '';
	const content = message.content;
	if (typeof content === 'string') return content;
	return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** The last non-system message of a request. */
function last(messages: readonly Message[]): Message | undefined {
	return messages.findLast((message) => message.role !== 'system');
}

/** Every prompt section in effect for a request. */
function sections(messages: readonly Message[]): Record<string, string> {
	const shown: Record<string, string> = {};
	for (const message of messages) {
		if (message.role !== 'system' || message.sections === undefined) continue;
		for (const [key, value] of Object.entries(message.sections)) {
			if (value === null) delete shown[key];
			else shown[key] = value;
		}
	}
	return shown;
}

function route(respond: (messages: readonly Message[]) => AssistantMessage): FauxResponseStep[] {
	return Array.from(
		{ length: 24 },
		() => (request: { messages: Message[] }) => respond(request.messages),
	);
}

const call = (name: string, args: Record<string, unknown> = {}) =>
	fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: 'toolUse' });

async function entries(host: FluePiHost, conversationId: ConversationId): Promise<EntryRecord[]> {
	const conversation = await host.harness.conversation(conversationId, context);
	const page = await conversation?.entries({}, 500, undefined, context);
	return [...(page?.items ?? [])].reverse();
}

async function entryText(
	host: FluePiHost,
	conversationId: ConversationId,
	id: number,
): Promise<string> {
	const found = (await entries(host, conversationId)).find((entry) => entry.id === (id as EntryId));
	return textOf(found?.model?.[0]);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('FluePiHost admission and settlement', () => {
	it('dispatch → receipt → settlement completed', async () => {
		const f = fixture();
		f.faux.setResponses([fauxAssistantMessage('hello back')]);
		const host = await f.open();
		const input = admission('hello');
		const receipt = await host.admit(input, context);
		expect(receipt.submissionId).toBe(input.submissionId);
		expect(receipt.acceptedAt).toBe(input.acceptedAt);
		expect(receipt.uid).toMatch(/^inst_/);
		expect(receipt.deduplicated).toBeUndefined();
		const settlement = await host.waitForSettlement(input.submissionId, context);
		expect(settlement.outcome).toBe('completed');
		expect(settlement.answeredBySubmissionId).toBeUndefined();
		expect(await entryText(host, ROOT_CONVERSATION_ID, settlement.answerEntryId ?? -1)).toBe(
			'hello back',
		);
		await host.close(context);
	});

	it('deduplicates a keyed redelivery onto the original receipt', async () => {
		const f = fixture();
		f.faux.setResponses([fauxAssistantMessage('once')]);
		const host = await f.open();
		const submissionId = await deriveKeyedSubmissionId(entity.type, entity.id, 'evt-1');
		const first = await host.admit(admission('hi', { submissionId }), context);
		const second = await host.admit(
			admission('hi', { submissionId, acceptedAt: '2030-01-01T00:00:00.000Z' }),
			context,
		);
		expect(second).toEqual({ ...first, deduplicated: true });
		expect((await host.waitForSettlement(submissionId, context)).outcome).toBe('completed');
		expect(f.faux.state.callCount).toBe(1);
		await host.close(context);
	});

	it('rejects a reused key with a different payload with the 409 conflict', async () => {
		const f = fixture();
		f.faux.setResponses([fauxAssistantMessage('ok')]);
		const host = await f.open();
		const submissionId = await deriveKeyedSubmissionId(entity.type, entity.id, 'evt-2');
		await host.admit(admission('first', { submissionId }), context);
		const error = await host
			.admit(admission('different', { submissionId }), context)
			.catch((e) => e);
		expect(error).toBeInstanceOf(SubmissionConflictError);
		expect((error as SubmissionConflictError).status).toBe(409);
		expect((error as SubmissionConflictError).submissionId).toBe(submissionId);
		await host.close(context);
	});

	it('enforces uid send conditions: create-only and must-match', async () => {
		const f = fixture();
		f.faux.setResponses(route(() => fauxAssistantMessage('ok')));
		const host = await f.open();
		const missing = await host.admit(admission('x', { uid: 'inst_nope' }), context).catch((e) => e);
		expect(missing).toBeInstanceOf(AgentInstanceNotFoundError);
		const seeded = await host
			.admit(admission('x', { uid: 'inst_nope', initialData: { a: 1 } }), context)
			.catch((e) => e);
		expect(seeded).toBeInstanceOf(InvalidRequestError);

		const create = admission('birth', { uid: null, initialData: { plan: 'pro' } });
		const born = await host.admit(create, context);
		// Redelivering the create-only send converges instead of failing its own condition.
		expect(await host.admit(create, context)).toEqual({ ...born, deduplicated: true });

		const again = await host.admit(admission('x', { uid: null }), context).catch((e) => e);
		expect(again).toBeInstanceOf(AgentInstanceExistsError);
		expect((again as AgentInstanceExistsError).uid).toBe(born.uid);
		expect((again as AgentInstanceExistsError).status).toBe(409);

		const mismatch = await host
			.admit(admission('x', { uid: 'inst_other' }), context)
			.catch((e) => e);
		expect(mismatch).toBeInstanceOf(AgentInstanceNotFoundError);
		expect((mismatch as AgentInstanceNotFoundError).status).toBe(404);

		const matched = await host.admit(admission('continue', { uid: born.uid }), context);
		expect(matched.uid).toBe(born.uid);
		expect((await host.waitForSettlement(matched.submissionId, context)).outcome).toBe('completed');
		await host.close(context);
	});

	it('steers a busy run with a join and queues a follow-up as its own run', async () => {
		const f = fixture();
		const started = deferred();
		const gate = deferred();
		const waitTool = defineTool({
			name: 'wait_gate',
			description: 'Wait for the gate.',
			async run() {
				started.resolve();
				await gate.promise;
				return 'gate open';
			},
		});
		f.faux.setResponses(
			route((messages) => {
				const message = last(messages);
				if (message?.role === 'toolResult') return fauxAssistantMessage('answer-1');
				const text = textOf(message);
				if (text === 'first') return call('wait_gate');
				if (text === 'steer') return fauxAssistantMessage('answer-1');
				return fauxAssistantMessage(`answer-for-${text}`);
			}),
		);
		const host = await f.open(agent({ tools: [waitTool] }));
		const first = await host.admit(admission('first'), context);
		await started.promise;
		const steer = await host.admit(admission('steer', { whenBusy: 'steer' }), context);
		const followUp = await host.admit(admission('followup', { whenBusy: 'followUp' }), context);
		gate.resolve();

		const a = await host.waitForSettlement(first.submissionId, context);
		const b = await host.waitForSettlement(steer.submissionId, context);
		const c = await host.waitForSettlement(followUp.submissionId, context);
		expect([a.outcome, b.outcome, c.outcome]).toEqual(['completed', 'completed', 'completed']);
		expect(b.answerEntryId).toBe(a.answerEntryId);
		expect(b.answeredBySubmissionId).toBe(first.submissionId);
		expect(a.answeredBySubmissionId).toBeUndefined();
		expect(c.answerEntryId).not.toBe(a.answerEntryId);
		expect(await entryText(host, ROOT_CONVERSATION_ID, c.answerEntryId ?? -1)).toBe(
			'answer-for-followup',
		);
		await host.close(context);
	});
});

describe('FluePiHost crash recovery', () => {
	it('repairs a crash between admission commit A and commit B on wake', async () => {
		const f = fixture();
		f.faux.setResponses([fauxAssistantMessage('recovered')]);
		const crashed = await f.open();
		const input = admission('before the crash');
		const begun = await beginAdmission(crashed.harness, entity, input, {}, context);
		expect(begun.receipt.status).toBe('admitting');
		await crashed.close(context);

		const host = await f.open();
		expect(await host.settlement(input.submissionId, context)).toBeUndefined();
		await host.wake({ kind: 'dispatch' }, context);
		expect((await host.harness.snapshot(FlueReceiptIndex, context))?.admitting).toEqual([]);
		const settlement = await host.waitForSettlement(input.submissionId, context);
		expect(settlement.outcome).toBe('completed');
		// A caller retry after the repair converges on the same receipt.
		const retried = await host.admit(input, context);
		expect(retried.deduplicated).toBe(true);
		expect(retried.acceptedAt).toBe(input.acceptedAt);
		await host.close(context);
	});

	it('reruns replay-safe (durable) tools and settles unsafe ones as interrupted after a crash', async () => {
		const f = fixture();
		let blocked = true;
		let effects = 0;
		// Normally the Harness close aborts the invocation signal; the crash
		// deferred is a fallback so a missed signal cannot hang the test.
		const crash = deferred();
		const bothStarted = { durable: deferred(), plain: deferred() };
		const block = (signal: AbortSignal | undefined) =>
			blocked
				? new Promise<never>((_resolve, reject) => {
						signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
						void crash.promise.then(() => reject(new Error('process crashed')));
					})
				: Promise.resolve();
		const durableTool = defineTool({
			name: 'durable_tool',
			description: 'A durable effect.',
			durable: true,
			async run(ctx) {
				const receipt = await ctx.step.do('effect', () => {
					effects += 1;
					return { charged: effects };
				});
				bothStarted.durable.resolve();
				await block(ctx.signal);
				return { output: receipt };
			},
		});
		const plainTool = defineTool({
			name: 'plain_tool',
			description: 'A non-durable effect.',
			async run(ctx) {
				bothStarted.plain.resolve();
				await block(ctx.signal);
				return 'plain done';
			},
		});
		f.faux.setResponses([
			fauxAssistantMessage([fauxToolCall('durable_tool', {}), fauxToolCall('plain_tool', {})], {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('all settled'),
		]);
		const render = agent({ tools: [durableTool, plainTool] });
		const crashed = await f.open(render);
		const input = admission('run both');
		await crashed.admit(input, context);
		await Promise.all([bothStarted.durable.promise, bothStarted.plain.promise]);
		const closing = crashed.close(context);
		setTimeout(() => crash.resolve(), 50);
		await closing;

		blocked = false;
		const host = await f.open(render);
		await host.wake({ kind: 'live-tasks' }, context);
		const settlement = await host.waitForSettlement(input.submissionId, context);
		expect(settlement.outcome).toBe('completed');
		expect(effects).toBe(1);

		const results = (await entries(host, ROOT_CONVERSATION_ID)).flatMap((entry) => {
			const message = entry.model?.[0];
			return message?.role === 'toolResult' ? [message] : [];
		});
		const durableResult = results.find((message) => message.toolName === 'durable_tool');
		const plainResult = results.find((message) => message.toolName === 'plain_tool');
		expect(durableResult?.isError).toBe(false);
		expect(textOf(durableResult)).toBe(JSON.stringify({ charged: 1 }));
		expect(textOf(plainResult)).toContain('was interrupted');
		await host.close(context);
	});
});

describe('FluePiHost render mapping', () => {
	it('maps model, thinking level, active tools and compaction onto the conversation', async () => {
		const f = fixture();
		const tool = defineTool({
			name: 'lookup',
			description: 'Look something up.',
			run: () => 'found',
		});
		const host = await f.open(
			agent({
				thinkingLevel: 'high',
				tools: [tool],
				compaction: { reserveTokens: 1234, keepRecentTokens: 567 },
			}),
		);
		const root = await host.harness.root(context);
		const agentView = await root.agent(context);
		expect(agentView.model).toEqual({ provider: 'faux', modelId: 'faux-1' });
		expect(agentView.thinkingLevel).toBe('high');
		expect(agentView.tools.map((t) => t.name)).toEqual(['task', 'activate_skill', 'lookup']);

		await host.applyRender(agent({ compaction: false }), context);
		const updatedAgentView = await root.agent(context);
		expect(updatedAgentView.tools.map((t) => t.name)).toEqual(['task', 'activate_skill']);
		expect(host.registry.snapshot().tools().find((t) => t.tool.name === 'lookup')).toBeUndefined();
		await host.close(context);
	});

	it('runs useAgentStart appends and useAgentFinish continuations through the generation hooks', async () => {
		const f = fixture();
		const seen: string[][] = [];
		let finishes = 0;
		f.faux.setResponses(
			route((messages) => {
				seen.push(messages.filter((message) => message.role === 'user').map(textOf));
				return fauxAssistantMessage(`reply-${seen.length}`);
			}),
		);
		const render = agent(
			{},
			{
				agentStarts: [
					{ run: (ctx) => ctx.append({ kind: 'signal', type: 'note', body: 'remember the tide' }) },
				],
				agentFinishes: [
					{
						run: (ctx) => {
							finishes += 1;
							if (finishes === 1)
								ctx.append({ kind: 'signal', type: 'nudge', body: 'one more pass' });
						},
					},
				],
				responseStarts: [{ run: () => ({ started: true }) }],
				responseFinishes: [{ run: (ctx) => ({ tools: ctx.response.toolCalls.length }) }],
			},
		);
		const host = await f.open(render);
		const input = admission('hello');
		await host.admit(input, context);
		const settlement = await host.waitForSettlement(input.submissionId, context);
		expect(settlement.outcome).toBe('completed');
		expect(seen).toHaveLength(2);
		expect(seen[0]?.[1]).toContain('remember the tide');
		expect(seen[1]?.join('\n')).toContain('one more pass');
		expect(seen[1]?.join('\n')).toContain('remember the tide');
		expect(finishes).toBe(2);
		const metadata = (await entries(host, ROOT_CONVERSATION_ID)).find(
			(entry) => entry.kind === 'flue.metadata',
		);
		expect(metadata?.data).toMatchObject({ metadata: { started: true, tools: 0 } });
		await host.close(context);
	});
});

describe('FluePiHost subagents and skills', () => {
	it('delegates to a subagent through the task tool and returns its answer', async () => {
		const f = fixture();
		const researcher: SubagentDefinition = {
			name: 'researcher',
			description: 'Finds facts.',
			agent: () => 'You are a meticulous researcher.',
		};
		let childSections: Record<string, string> = {};
		f.faux.setResponses(
			route((messages) => {
				const message = last(messages);
				if (message?.role === 'toolResult')
					return fauxAssistantMessage(`parent heard: ${textOf(message)}`);
				const text = textOf(message);
				if (text === 'delegate please')
					return call('task', { agent: 'researcher', prompt: 'find the answer' });
				if (text === 'direct question') return fauxAssistantMessage('direct answer');
				if (text === 'find the answer') {
					childSections = sections(messages);
					return fauxAssistantMessage([fauxText('the answer is 42')]);
				}
				return fauxAssistantMessage('unexpected');
			}),
		);
		const host = await f.open(
			agent({ instructions: 'You are the parent.', subagents: [researcher] }),
		);
		const input = admission('delegate please');
		await host.admit(input, context);
		const settlement = await host.waitForSettlement(input.submissionId, context);
		expect(settlement.outcome).toBe('completed');
		expect(await entryText(host, ROOT_CONVERSATION_ID, settlement.answerEntryId ?? -1)).toBe(
			'parent heard: the answer is 42',
		);
		expect(childSections.flue_instructions).toBe('You are a meticulous researcher.');
		expect(childSections.flue_agents).toContain('None.');

		const children = await host.harness.commit(
			(tx) => tx.scanConversations({ ownerConversationId: ROOT_CONVERSATION_ID }, 10),
			context,
		);
		expect(children.items).toHaveLength(1);
		expect(children.items[0]?.owner?.conversationId).toBe(ROOT_CONVERSATION_ID);

		// The programmatic twin: session.task().
		const direct = await host.task(
			undefined,
			{ agent: 'researcher', prompt: 'direct question' },
			context,
		);
		expect(direct.text).toBe('direct answer');
		await host.close(context);
	});

	it('renders the skills section and activates a skill with formatSkillInvocation', async () => {
		const f = fixture();
		const deploy = defineSkill({
			name: 'deploy',
			description: 'Deploy the application.',
			instructions: 'Run the deploy script, then verify the health check.',
		});
		let rootSections: Record<string, string> = {};
		f.faux.setResponses(
			route((messages) => {
				const message = last(messages);
				if (message?.role === 'toolResult') return fauxAssistantMessage(textOf(message));
				rootSections = sections(messages);
				return textOf(message) === 'missing'
					? call('activate_skill', { name: 'nope' })
					: call('activate_skill', { name: 'deploy' });
			}),
		);
		const host = await f.open(agent({ skills: [deploy] }));
		const input = admission('ship it');
		await host.admit(input, context);
		const settlement = await host.waitForSettlement(input.submissionId, context);
		expect(rootSections.flue_skills).toContain('<name>deploy</name>');
		expect(rootSections.flue_skills).toContain(
			'<description>Deploy the application.</description>',
		);
		const activated = await entryText(host, ROOT_CONVERSATION_ID, settlement.answerEntryId ?? -1);
		expect(activated).toContain('<skill name="deploy" location="/.flue/packaged-skills/');
		expect(activated).toContain('Run the deploy script, then verify the health check.');

		const missing = admission('missing');
		await host.admit(missing, context);
		const missed = await host.waitForSettlement(missing.submissionId, context);
		expect(await entryText(host, ROOT_CONVERSATION_ID, missed.answerEntryId ?? -1)).toBe(
			'Skill "nope" is not available. Available skills: deploy.',
		);
		await host.close(context);
	});
});
