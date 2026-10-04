/**
 * The question scenarios (docs/cloudflare-native.md rule 9), run through
 * `FlueAgentInstance` — the core both coordinators drive — over any entity
 * log: `questions.test.ts` runs them over the in-memory log, and
 * `questions.electric.test.ts` against a real Durable Streams server.
 *
 * Code Mode runs Pi's QuickJS sandbox in-process, as on workerd: a script
 * waiting on an approval is lost with its instance and rerun over its
 * journal (`codemode/journal.ts`) on the next one. MCP runs against an in-process stateless 2026-07-28 server that
 * answers `tools/call` with an elicitation `input_required`.
 *
 * Wakes are driven by hand: the alarm is `instance.wake({ kind: 'pump' })`
 * after a doorbell, and an eviction is `close()` followed by a new instance
 * over the same SQLite file. Imported only by `*.test.ts`.
 */
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
} from '@earendil-works/pi-ai';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { useCodeMode } from '../hooks/use-code-mode.ts';
import { defineMcpConnection, useMcpConnection } from '../hooks/use-mcp-connection.ts';
import { useModel } from '../hooks/use-model.ts';
import { type UseQuestionsOptions, useQuestions } from '../hooks/use-questions.ts';
import { useTool } from '../hooks/use-tool.ts';
import { createMcpConnectionCache, type McpConnectionCache } from '../mcp.ts';
import type { McpConnectionDefinition } from '../mcp-types.ts';
import { openNodeSqliteDatabase } from '../node/node-sqlite-database.ts';
import { LIVE_TASK_BACKSTOP_MS, type WakeReason } from '../pi/host.ts';
import { FlueQuestions } from '../pi/questions.ts';
import type { FlueAnswer } from '../questions.ts';
import { FlueAgentInstance } from '../runtime/agent-instance.ts';
import { InMemoryAttachmentStore } from '../runtime/attachment-store.ts';
import { resetModelsForTests, setProvider } from '../runtime/providers.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import type { Agent } from '../types.ts';
import {
	context,
	eventually,
	readAll,
	removeTempFiles,
	tempFile,
	textOf,
} from './a2a-test-support.ts';
import { inboxPath, questionsPath } from './paths.ts';
import { appendAnswer, type InputRequestedEvent } from './questions.ts';
import { appendCreating } from './append.ts';
import type { SemanticEmitter } from '../reactor/reactor.ts';
import type { EntityRef } from './services.ts';

const SEND_EMAIL_CODE = "await tools.send_email({ to: 'ops' }); return 'sent';";

type Respond = (messages: readonly Message[]) => AssistantMessage;

function toolCallMessage(name: string, args: Record<string, unknown>): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: 'toolUse' });
}

/** The text of every user (and signal) message of a request. */
function userText(messages: readonly Message[]): string {
	return messages
		.filter((message) => message.role === 'user')
		.map((message) => textOf(message))
		.join('\n');
}

/** An in-process stateless 2026-07-28 MCP server whose `deploy` asks for confirmation. */
export function elicitingServer() {
	const calls: Record<string, unknown>[] = [];
	const buildServer = () => {
		const server = new Server(
			{ name: 'ops', version: '1.0.0' },
			{ capabilities: { tools: {} }, instructions: 'Deploys things.' },
		);
		server.setRequestHandler('tools/list', (async () => ({
			tools: [
				{
					name: 'deploy',
					description: 'Deploy a service; asks the user to confirm.',
					inputSchema: {
						type: 'object',
						properties: { service: { type: 'string' } },
						required: ['service'],
					},
				},
			],
		})) as never);
		return server;
	};
	const handler = createMcpHandler(buildServer, { legacy: 'reject', responseMode: 'json' });
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.method === 'POST') {
			const body = (await request.clone().json()) as {
				id?: number;
				method?: string;
				params?: Record<string, unknown>;
			};
			if (body.method === 'tools/call') {
				calls.push(body.params ?? {});
				const responses = body.params?.inputResponses as Record<string, unknown> | undefined;
				if (responses) {
					return Response.json({
						jsonrpc: '2.0',
						id: body.id,
						result: {
							resultType: 'complete',
							content: [
								{
									type: 'text',
									text: `deployed ${String((body.params?.arguments as { service?: string })?.service)} with ${JSON.stringify(responses)} and ${String(body.params?.requestState)}`,
								},
							],
						},
					});
				}
				// The server SDK refuses to ask a client without the elicitation
				// capability; an elicitation-style input_required, written out.
				return Response.json({
					jsonrpc: '2.0',
					id: body.id,
					result: {
						resultType: 'input_required',
						requestState: 'opaque-state-1',
						inputRequests: {
							confirm: {
								method: 'elicitation/create',
								params: {
									mode: 'form',
									message: 'Deploy to production?',
									requestedSchema: {
										type: 'object',
										properties: { approved: { type: 'boolean' } },
									},
								},
							},
						},
					},
				});
			}
		}
		return handler.fetch(request);
	}) as typeof fetch;
	return { calls, fetch: fetchFn };
}

export interface QuestionLogFactory {
	/** A fresh log for one test (a fresh entity type per test keeps runs apart on a shared server). */
	create(): Promise<DurableStreamLog>;
}

interface Harness {
	readonly log: DurableStreamLog;
	readonly clock: { now: number };
	readonly wakes: { atMs: number; reason: WakeReason }[];
	readonly reports: unknown[];
	readonly toolResults: string[];
	readonly effects: { emails: number };
	respond: Respond;
	open(
		agent: Agent,
		ref: EntityRef,
		file: string,
		mcp?: McpConnectionCache,
	): Promise<FlueAgentInstance>;
	ask(instance: FlueAgentInstance, body: string): Promise<void>;
	parked(instance: FlueAgentInstance): Promise<string>;
}

/** The stream's messages once it holds one (a publish lands just after the park). */
async function published1(log: DurableStreamLog, path: string): Promise<unknown[]> {
	await eventually(async () => ((await readAll(log, path)).length > 0 ? true : undefined), {
		what: `an event on ${path}`,
	});
	return readAll(log, path);
}

/** Define the scenarios over `factory`'s log. */
export function defineQuestionScenarios(label: string, factory: QuestionLogFactory): void {
	const instances: FlueAgentInstance[] = [];
	let counter = 0;
	const responders: { current: Respond } = { current: () => fauxAssistantMessage('ok') };

	afterEach(async () => {
		for (const instance of instances) await instance.close().catch(() => {});
		instances.length = 0;
		resetModelsForTests();
	});

	afterAll(async () => {
		await removeTempFiles();
	});

	async function harness(): Promise<Harness> {
		const faux = fauxProvider({ provider: 'qa', models: [{ id: 'm' }] });
		faux.setResponses(
			Array.from(
				{ length: 400 },
				() => (request: { messages: Message[] }) => responders.current(request.messages),
			) as never,
		);
		setProvider(faux.provider);
		const log = await factory.create();
		const state: Harness = {
			log,
			clock: { now: Date.now() },
			wakes: [],
			reports: [],
			toolResults: [],
			effects: { emails: 0 },
			get respond() {
				return responders.current;
			},
			set respond(next: Respond) {
				responders.current = (messages) => {
					const last = messages.findLast((message) => message.role !== 'system');
					if (last?.role === 'toolResult') state.toolResults.push(textOf(last));
					return next(messages);
				};
			},
			async open(agent, ref, file, mcp) {
				const database = await openNodeSqliteDatabase(file);
				const instance = new FlueAgentInstance({
					agentName: ref.type,
					instanceId: ref.id,
					agent,
					database: () => database,
					attachments: new InMemoryAttachmentStore(),
					armWake: (atMs, reason) => {
						state.wakes.push({ atMs, reason });
					},
					events: { emitEvent: () => ({}) } as never,
					mcp: mcp ?? createMcpConnectionCache(),
					entities: { log },
					now: () => state.clock.now,
					onReport: (error) => state.reports.push(error),
				});
				instances.push(instance);
				return instance;
			},
			async ask(instance, body) {
				await instance.admit({
					kind: 'direct',
					submissionId: `sub_${++counter}_${Date.now()}`,
					message: { kind: 'user', body },
					acceptedAt: new Date(state.clock.now).toISOString(),
				});
			},
			async parked(instance) {
				const [pending] = await eventually(
					async () => {
						const questions = await instance.pendingQuestions();
						return questions.length > 0 ? questions : undefined;
					},
					{ what: 'a parked question' },
				);
				return (pending as { id: string }).id;
			},
		};
		return state;
	}

	/** An agent that emails through Code Mode, with approval required. */
	function mailer(state: Harness, questions?: UseQuestionsOptions): Agent {
		return (() => {
			useModel('qa/m');
			useTool({
				name: 'send_email',
				description: 'Send an email.',
				run: () => {
					state.effects.emails++;
					return 'queued';
				},
			});
			useCodeMode({ requiresApproval: ['send_email'] });
			if (questions) useQuestions(questions);
			return 'You send email when asked.';
		}) as unknown as Agent;
	}

	const mailerResponds: Respond = (messages) => {
		const last = messages.findLast((message) => message.role !== 'system');
		if (last?.role === 'toolResult') return fauxAssistantMessage('done');
		if (userText(messages).includes('email'))
			return toolCallMessage('codemode', { code: SEND_EMAIL_CODE });
		return fauxAssistantMessage('ok');
	};

	/** Ring `instance`'s inbox doorbell at the stream's head and run its alarm. */
	async function deliver(state: Harness, instance: FlueAgentInstance, ref: EntityRef) {
		const inbox = inboxPath(ref);
		const head = await state.log.head(inbox);
		if (head) await instance.ring(inbox, head.nextOffset);
		return instance.wake({ kind: 'pump' });
	}

	describe(`questions over ${label}`, () => {
		it('approval: parks without a model round trip, survives eviction, resumes once on the inbox answer', async () => {
			const state = await harness();
			const ref: EntityRef = { type: `mailer${++counter}`, id: 'alice' };
			state.respond = mailerResponds;
			const file = await tempFile(`${ref.type}.sqlite`);
			const agent = mailer(state);
			const first = await state.open(agent, ref, file);
			await state.ask(first, 'please email ops');
			const questionId = await state.parked(first);
			expect(questionId).toMatch(/^codemode:\d+:.+:[0-9a-f]{12}$/);
			await first.waitForIdle();
			expect(state.effects.emails).toBe(0);
			// The model ran once: the turn waits inside the tool call, not on a new request.
			expect(state.toolResults).toEqual([]);

			// One input-requested event, with the question and the answer address
			// (published right after the question is parked).
			const published = await published1(state.log, questionsPath(ref));
			expect(published).toHaveLength(1);
			const event = published[0] as InputRequestedEvent;
			expect(event).toMatchObject({
				type: 'flue.input-requested',
				eventId: `input-requested:${ref.type}/alice/${questionId}`,
				from: ref,
				questionId,
				question: {
					kind: 'codemode-approval',
					pending: [{ connector: 'tools', method: 'send_email' }],
				},
				answerTo: { entity: ref, inbox: inboxPath(ref) },
			});

			// While parked, a wake arms no live-task backstop (only the
			// submission's own deadline) and writes nothing.
			const wakesBefore = state.wakes.length;
			const rowsBefore = await first.rows();
			await first.wake({ kind: 'live-tasks' });
			expect(
				state.wakes
					.slice(wakesBefore)
					.filter((wake) => wake.atMs === state.clock.now + LIVE_TASK_BACKSTOP_MS),
			).toEqual([]);
			expect((await first.rows())?.rowsWritten).toBe(rowsBefore?.rowsWritten);

			// Evict, more often than the attempt budget (10) allows retries: a
			// reopen under a parked question is not a retry.
			await first.close();
			let second = await state.open(agent, ref, file);
			for (let eviction = 0; eviction < 11; eviction++) {
				expect((await second.pendingQuestions()).map((question) => question.id)).toEqual([
					questionId,
				]);
				await second.close();
				second = await state.open(agent, ref, file);
			}

			const testEmitter: SemanticEmitter = {
				async emitSemantic(entry, options) {
					await appendCreating(state.log, entry.stream, entry.event, options?.signal);
				},
			};

			// A person answers through the inbox, like any participant.
			await appendAnswer(testEmitter, ref, {
				from: { type: 'person', id: 'pat' },
				questionId,
				answer: { kind: 'codemode-approval', decision: 'approve' },
				eventId: 'answer-1',
			});
			const woken = await deliver(state, second, ref);
			expect(woken.pump?.answered).toEqual([questionId]);
			await second.waitForIdle();
			expect(state.effects.emails).toBe(1);
			expect(state.toolResults).toHaveLength(1);
			expect(state.toolResults[0]).toContain('Script completed');
			expect(state.toolResults[0]).toContain('sent');
			expect(await second.pendingQuestions()).toEqual([]);

			// Duplicate and late answers change nothing and are reported.
			await appendAnswer(testEmitter, ref, {
				from: { type: 'person', id: 'pat' },
				questionId,
				answer: { kind: 'codemode-approval', decision: 'approve' },
				eventId: 'answer-1',
			});
			await appendAnswer(testEmitter, ref, {
				from: { type: 'person', id: 'sam' },
				questionId,
				answer: { kind: 'codemode-approval', decision: 'reject' },
				eventId: 'answer-2',
			});
			await appendAnswer(testEmitter, ref, {
				from: { type: 'person', id: 'sam' },
				questionId: 'codemode:flue:nope:0',
				answer: { kind: 'codemode-approval', decision: 'approve' },
				eventId: 'answer-3',
			});
			const again = await deliver(state, second, ref);
			expect(again.pump?.answered).toEqual([]);
			await second.waitForIdle();
			expect(state.effects.emails).toBe(1);
			const ignored = state.reports.map(String).filter((line) => line.includes('Ignored answer'));
			expect(ignored).toHaveLength(3);
			expect(ignored.some((line) => line.includes('already answered'))).toBe(true);
			expect(ignored.some((line) => line.includes('no such question'))).toBe(true);
			const host = await second.host();
			const record = await host.harness.snapshot(FlueQuestions, questionId, context);
			expect(record).toMatchObject({
				status: 'answered',
				answeredBy: { type: 'person', id: 'pat' },
				answerEventId: 'answer-1',
			});
		}, 60_000);

		it('reject: the execution ends, the effect never runs, the model hears why', async () => {
			const state = await harness();
			const ref: EntityRef = { type: `mailer${++counter}`, id: 'alice' };
			state.respond = mailerResponds;
			const instance = await state.open(mailer(state), ref, await tempFile(`${ref.type}.sqlite`));
			await state.ask(instance, 'please email ops');
			const questionId = await state.parked(instance);
			const answered = await instance.answerQuestion(questionId, {
				kind: 'codemode-approval',
				decision: 'reject',
				reason: 'not today',
			});
			expect(answered.status).toBe('accepted');
			await instance.wake({ kind: 'pump' });
			await instance.waitForIdle();
			expect(state.effects.emails).toBe(0);
			expect(state.toolResults).toHaveLength(1);
			expect(state.toolResults[0]).toContain('rejected: not today');
			// Answering a settled question is refused before anything is appended.
			const inbox = await readAll(state.log, inboxPath(ref));
			expect(
				await instance.answerQuestion(questionId, {
					kind: 'codemode-approval',
					decision: 'approve',
				}),
			).toEqual({ status: 'settled', questionStatus: 'answered' });
			expect(
				await instance.answerQuestion('codemode:flue:none:0', {
					kind: 'codemode-approval',
					decision: 'approve',
				}),
			).toEqual({ status: 'unknown' });
			expect(await readAll(state.log, inboxPath(ref))).toHaveLength(inbox.length);
		}, 60_000);

		it('timeout: the alarm at the deadline expires the question and the call fails', async () => {
			const state = await harness();
			const ref: EntityRef = { type: `mailer${++counter}`, id: 'alice' };
			state.respond = mailerResponds;
			const instance = await state.open(
				mailer(state, { timeoutMs: 60_000 }),
				ref,
				await tempFile(`${ref.type}.sqlite`),
			);
			const askedAt = state.clock.now;
			await state.ask(instance, 'please email ops');
			const questionId = await state.parked(instance);
			const [pending] = await instance.pendingQuestions();
			expect(pending?.timeoutAt).toBe(askedAt + 60_000);
			await eventually(() =>
				state.wakes.some(
					(wake) => wake.atMs === askedAt + 60_000,
				),
			);
			// Early: nothing expires.
			state.clock.now = askedAt + 30_000;
			await instance.wake({ kind: 'questions' });
			expect(await instance.pendingQuestions()).toHaveLength(1);
			// The deadline.
			state.clock.now = askedAt + 60_001;
			await instance.wake({ kind: 'questions' });
			await instance.waitForIdle();
			expect(await instance.pendingQuestions()).toEqual([]);
			expect(state.effects.emails).toBe(0);
			expect(state.toolResults).toHaveLength(1);
			expect(state.toolResults[0]).toContain('expired');
			// A late answer is ignored.
			expect(
				await instance.answerQuestion(questionId, {
					kind: 'codemode-approval',
					decision: 'approve',
				}),
			).toEqual({ status: 'settled', questionStatus: 'expired' });
		}, 60_000);

		it('MCP input_required: parks, survives eviction, retries with the answers and the byte-exact requestState', async () => {
			const state = await harness();
			const ref: EntityRef = { type: `deployer${++counter}`, id: 'alice' };
			const server = elicitingServer();
			const ops: McpConnectionDefinition = defineMcpConnection({
				name: 'ops',
				url: 'https://ops.test/mcp',
				fetch: server.fetch,
			});
			const agent = (() => {
				useModel('qa/m');
				useMcpConnection(ops);
				return 'You deploy when asked.';
			}) as unknown as Agent;
			state.respond = (messages) => {
				const last = messages.findLast((message) => message.role !== 'system');
				if (last?.role === 'toolResult') return fauxAssistantMessage('done');
				if (userText(messages).includes('deploy'))
					return toolCallMessage('mcp__ops__deploy', { service: 'api' });
				return fauxAssistantMessage('ok');
			};
			const file = await tempFile(`${ref.type}.sqlite`);
			const first = await state.open(agent, ref, file);
			await state.ask(first, 'deploy the api');
			const questionId = await state.parked(first);
			expect(questionId).toMatch(/^mcp:ops:[0-9a-f]{16}$/);
			const [pending] = await first.pendingQuestions();
			expect(pending?.question).toMatchObject({
				kind: 'mcp-input',
				server: 'ops',
				method: 'tools/call',
				params: { name: 'deploy', arguments: { service: 'api' } },
				requestState: 'opaque-state-1',
			});
			expect(server.calls).toHaveLength(1);

			await first.close();
			const second = await state.open(agent, ref, file, createMcpConnectionCache());
			const answer: FlueAnswer = {
				kind: 'mcp-input',
				inputResponses: { confirm: { action: 'accept', content: { approved: true } } },
			};
			expect((await second.answerQuestion(questionId, answer)).status).toBe('accepted');
			await second.wake({ kind: 'pump' });
			await second.waitForIdle();
			// The rerun did not call the server from scratch: one retry, with the answers and the state.
			expect(server.calls).toHaveLength(2);
			expect(server.calls[1]).toMatchObject({
				name: 'deploy',
				arguments: { service: 'api' },
				requestState: 'opaque-state-1',
				inputResponses: { confirm: { action: 'accept', content: { approved: true } } },
			});
			expect(state.toolResults).toEqual([
				'deployed api with {"confirm":{"action":"accept","content":{"approved":true}}} and opaque-state-1',
			]);
		}, 60_000);

		it('MCP input_required inside a Code Mode script: parks, survives eviction, retries once; earlier calls are not repeated', async () => {
			const state = await harness();
			const ref: EntityRef = { type: `scripter${++counter}`, id: 'alice' };
			const server = elicitingServer();
			const ops: McpConnectionDefinition = defineMcpConnection({
				name: 'ops',
				url: 'https://ops.test/mcp',
				fetch: server.fetch,
			});
			const agent = (() => {
				useModel('qa/m');
				useTool({
					name: 'note',
					description: 'Take a note.',
					run: () => {
						state.effects.emails++;
						return 'noted';
					},
				});
				useMcpConnection(ops);
				useCodeMode();
				return 'You deploy from scripts.';
			}) as unknown as Agent;
			state.respond = (messages) => {
				const last = messages.findLast((message) => message.role !== 'system');
				if (last?.role === 'toolResult') return fauxAssistantMessage('done');
				if (userText(messages).includes('deploy'))
					return toolCallMessage('codemode', {
						code: "const noted = await tools.note({}); const r = await tools.mcp__ops__deploy({ service: 'api' }); return [noted, r.content[0].text];",
					});
				return fauxAssistantMessage('ok');
			};
			const file = await tempFile(`${ref.type}.sqlite`);
			const first = await state.open(agent, ref, file);
			await state.ask(first, 'deploy the api');
			const questionId = await state.parked(first);
			expect(questionId).toMatch(/^mcp:ops:[0-9a-f]{16}$/);
			expect(server.calls).toHaveLength(1);
			expect(state.effects.emails).toBe(1);

			// Evicted while it waits: the script is gone from memory.
			await first.close();
			const second = await state.open(agent, ref, file, createMcpConnectionCache());
			const answer: FlueAnswer = {
				kind: 'mcp-input',
				inputResponses: { confirm: { action: 'accept', content: { approved: true } } },
			};
			expect((await second.answerQuestion(questionId, answer)).status).toBe('accepted');
			await second.wake({ kind: 'pump' });
			await second.waitForIdle();
			// The rerun answered note() from the journal, and retried the parked
			// request once, with the answers and the byte-exact requestState.
			expect(state.effects.emails).toBe(1);
			expect(server.calls).toHaveLength(2);
			expect(server.calls[1]).toMatchObject({
				name: 'deploy',
				arguments: { service: 'api' },
				requestState: 'opaque-state-1',
				inputResponses: { confirm: { action: 'accept', content: { approved: true } } },
			});
			expect(state.toolResults).toHaveLength(1);
			expect(state.toolResults[0]).toContain('Script completed');
			expect(state.toolResults[0]).toContain(
				'"deployed api with {\\"confirm\\":{\\"action\\":\\"accept\\",\\"content\\":{\\"approved\\":true}}} and opaque-state-1"',
			);
			expect(await second.pendingQuestions()).toEqual([]);
		}, 60_000);

		it("A2A: the question is on the stream and in the responder agent's inbox; that agent answers it", async () => {
			const state = await harness();
			const type = `team${++counter}`;
			const ALICE: EntityRef = { type, id: 'alice' };
			const BOB: EntityRef = { type, id: 'bob' };
			const asker = mailer(state, { responder: BOB });
			const reviewer = (() => {
				useModel('qa/m');
				return 'You review approvals.';
			}) as unknown as Agent;
			state.respond = (messages) => {
				const last = messages.findLast((message) => message.role !== 'system');
				if (last?.role === 'toolResult') return fauxAssistantMessage('done');
				const text = userText(messages);
				const asked = /question_id="([^"]+)"/.exec(text);
				if (asked && text.includes('asks:')) {
					return toolCallMessage('answer_question', {
						to: ALICE,
						question_id: asked[1],
						decision: 'approve',
					});
				}
				if (text.includes('email')) return toolCallMessage('codemode', { code: SEND_EMAIL_CODE });
				return fauxAssistantMessage('ok');
			};
			const alice = await state.open(asker, ALICE, await tempFile(`${type}-alice.sqlite`));
			const bob = await state.open(reviewer, BOB, await tempFile(`${type}-bob.sqlite`));
			await state.ask(alice, 'please email ops');
			const questionId = await state.parked(alice);

			// On Alice's questions stream, and the same event in Bob's inbox.
			const onStream = await published1(state.log, questionsPath(ALICE));
			const inBobsInbox = await published1(state.log, inboxPath(BOB));
			expect(onStream).toHaveLength(1);
			expect(inBobsInbox).toEqual(onStream);

			// Bob wakes on his doorbell, and his model answers with answer_question.
			await deliver(state, bob, BOB);
			await bob.waitForIdle();
			const answers = await readAll(state.log, inboxPath(ALICE));
			expect(answers).toEqual([
				expect.objectContaining({
					type: 'flue.input-answered',
					from: BOB,
					questionId,
					answer: { kind: 'codemode-approval', decision: 'approve' },
				}),
			]);

			// Alice wakes on hers and continues.
			const woken = await deliver(state, alice, ALICE);
			expect(woken.pump?.answered).toEqual([questionId]);
			await alice.waitForIdle();
			expect(state.effects.emails).toBe(1);
			expect(state.toolResults.filter((text) => text.includes('Script completed'))).toHaveLength(1);
		}, 60_000);
	});
}
