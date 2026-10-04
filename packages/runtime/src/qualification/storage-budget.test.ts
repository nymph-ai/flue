/**
 * Storage budget: the SQLite rows a Flue agent instance reads and writes per
 * scenario, against what Pi Durable itself reads and writes for the same
 * work on a bare `Harness` over the same storage. Durable Object SQLite is
 * billed (and charted per namespace) by rows read and written, and Pi commits
 * a streaming partial every 100 ms, so Flue's own per-commit cost has to be
 * near zero and must never grow with the instance's history.
 *
 * Rows are counted by Flue's `node:sqlite` facade (`node/node-sqlite-database.ts`):
 * rows a statement changed, and rows it returned. On workerd the same
 * statements report rows scanned, which can only be higher for reads; the
 * comparison between Flue and bare Pi is like for like.
 *
 * Each scenario runs at history size 10 and 1000 (admitted and answered
 * submissions before it). Flue's overhead — its rows minus bare Pi's at the
 * same size — must stay within a fixed allowance and be the same at both
 * sizes. `[storage-budget]` lines report every measurement.
 *
 * Code Mode (Pi's QuickJS sandbox, in-process as on workerd): a cold `store()` turn after
 * `size` earlier writes of the store (nymph-ai/nymphai #3862: without a
 * checkpoint predicate, its cold read replayed every write), and a question
 * parked on an approval (rule 9) — park, answer through the inbox, resume —
 * plus idle wakes while it waits, which must write nothing.
 */
import {
	type AssistantMessage,
	Type,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
} from '@earendil-works/pi-ai';
import {
	createRegistry,
	Harness,
	ROOT_CONVERSATION_ID,
	type ToolRegistration,
} from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FlueCodemodeStore } from '../codemode/store.ts';
import { useCodeMode } from '../hooks/use-code-mode.ts';
import { context, removeTempFiles, tempFile, textOf } from '../entity/a2a-test-support.ts';
import { inboxPath } from '../entity/paths.ts';
import { useModel } from '../hooks/use-model.ts';
import { useTool } from '../hooks/use-tool.ts';
import { createMcpConnectionCache } from '../mcp.ts';
import { type NodeSqliteDatabase, openNodeSqliteDatabase } from '../node/node-sqlite-database.ts';
import { CHECKPOINT_EVERY } from '../pi/conversation-cache.ts';
import { DELTAS_PER_BASE } from '../pi/docs.ts';
import { FlueAgentInstance } from '../runtime/agent-instance.ts';
import { InMemoryAttachmentStore } from '../runtime/attachment-store.ts';
import { resetModelsForTests, setProvider } from '../runtime/providers.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import type { Agent } from '../types.ts';

type Rows = { rowsRead: number; rowsWritten: number };

const SIZES = [10, 1000] as const;
const STREAM_TOKENS_PER_SECOND = 100;
/** ~30 partials: Pi commits a partial every 100 ms; 300 four-character tokens stream for 3 s. */
const STREAMED_TEXT = 'abcd'.repeat(300);

/**
 * Flue's allowance over bare Pi, per scenario. Every one is a fixed number
 * of rows; none may depend on the history size (asserted separately).
 */
const BUDGET: Record<string, Rows> = {
	'plain answer (~30 partials)': { rowsRead: 60, rowsWritten: 45 },
	'5-tool-call turn': { rowsRead: 60, rowsWritten: 50 },
	'A2A send (sender turn)': { rowsRead: 60, rowsWritten: 45 },
	'A2A receive (doorbell, pump, admission, turn)': { rowsRead: 25, rowsWritten: 45 },
	'idle wake': { rowsRead: 20, rowsWritten: 5 },
	'cold open + admission + turn': { rowsRead: 100, rowsWritten: 30 },
	'Code Mode store() turn, cold, after <size> store writes': { rowsRead: 120, rowsWritten: 50 },
	'parked question (ask, park, answer, resume)': { rowsRead: 85, rowsWritten: 70 },
	'3 idle wakes while a question is parked': { rowsRead: 30, rowsWritten: 0 },
};

const STORE_CODE = "const n = load('k') ?? 0; store('k', n + 1); return n + 1;";
const APPROVAL_CODE = "await tools.send({}); return 'sent';";

function respond(messages: readonly Message[]): AssistantMessage {
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
	const send = /send (\S+)\/(\S+)/.exec(text);
	if (send)
		return fauxAssistantMessage(
			[
				fauxToolCall('send_message', {
					target: { type: send[1] as string, id: send[2] as string },
					text: 'hi',
				}),
			],
			{ stopReason: 'toolUse' },
		);
	if (/stream/.test(text)) return fauxAssistantMessage([fauxText(STREAMED_TEXT)]);
	return fauxAssistantMessage([fauxText('ok')]);
}

function providers() {
	const fast = fauxProvider({ provider: 'fast', models: [{ id: 'm' }] });
	const slow = fauxProvider({
		provider: 'slow',
		models: [{ id: 'm' }],
		tokensPerSecond: STREAM_TOKENS_PER_SECOND,
		tokenSize: { min: 4, max: 4 },
	});
	for (const faux of [fast, slow]) {
		faux.setResponses(
			Array.from(
				{ length: 4000 },
				() => (request: { messages: Message[] }) => respond(request.messages),
			) as never,
		);
	}
	return { fast, slow };
}

/** The statements that read or wrote the most rows, for the report. */
function topStatements(statements: Map<string, Rows>): string[] {
	return [...statements.entries()]
		.sort(([, a], [, b]) => b.rowsRead + b.rowsWritten - (a.rowsRead + a.rowsWritten))
		.slice(0, 14)
		.map(
			([sql, rows]) =>
				`${rows.rowsRead}r ${rows.rowsWritten}w ${sql.replace(/\s+/g, ' ').slice(0, 110)}`,
		);
}

function delta(before: Rows, after: Rows): Rows {
	return {
		rowsRead: after.rowsRead - before.rowsRead,
		rowsWritten: after.rowsWritten - before.rowsWritten,
	};
}

// ─── Bare Pi ────────────────────────────────────────────────────────────────

async function bareHarness(file = ':memory:') {
	const { fast, slow } = providers();
	const models = createModels();
	models.setProvider(fast.provider);
	models.setProvider(slow.provider);
	const registry = createRegistry();
	registry.install({
		name: 'tools',
		tools: [
			{
				name: 'probe',
				description: 'Probe.',
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
			},
			{
				name: 'send_message',
				description: 'Send.',
				parameters: Type.Object({}, { additionalProperties: true }),
				execute: async () => ({ content: [{ type: 'text', text: 'sent' }] }),
			},
		],
	});
	const database = await openNodeSqliteDatabase(file);
	const storage = await SqliteStorage.open(database);
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context);
	if ((await root.agent(context)).model?.provider !== 'fast')
		await root.configure({ model: { provider: 'fast', modelId: 'm' } }, context);
	harness.resume();
	let counter = Date.now();
	const ask = async (content: string) => {
		const submission = await root.submit(
			{ type: 'input', content, requestId: `r${counter++}` },
			context,
		);
		await submission.wait(context);
		await harness.waitForIdle(context);
	};
	return {
		database,
		harness,
		root,
		ask,
		async history(size: number) {
			for (let n = 0; n < size; n++) await ask(`question ${n}`);
		},
		close: () => harness.close(context),
	};
}

// ─── Flue ───────────────────────────────────────────────────────────────────

const control = { model: 'fast/m' };

const BudgetAgent = (() => {
	useModel(control.model);
	useTool({ name: 'probe', description: 'Probe.', run: () => 'ok' });
	useTool({ name: 'send', description: 'Send.', run: () => 'sent' });
	useCodeMode({ requiresApproval: ['send'] });
	return 'You are a budget probe.';
}) as unknown as Agent;

const instances: FlueAgentInstance[] = [];

async function flueInstance(log: InMemoryDurableStreamLog, id: string, file = ':memory:') {
	const database: NodeSqliteDatabase = await openNodeSqliteDatabase(file);
	const instance = new FlueAgentInstance({
		agentName: 'budget',
		instanceId: id,
		agent: BudgetAgent,
		database: () => database,
		attachments: new InMemoryAttachmentStore(),
		armWake: () => {},
		events: { emitEvent: () => ({}) } as never,
		mcp: createMcpConnectionCache(),
		entities: { log },
	});
	instances.push(instance);
	let counter = Date.now();
	const start = async (body: string) => {
		const submissionId = `sub_${id}_${counter++}`;
		await instance.admit({
			kind: 'direct',
			submissionId,
			message: { kind: 'user', body },
			acceptedAt: new Date().toISOString(),
		});
		return submissionId;
	};
	const ask = async (body: string) => {
		const submissionId = await start(body);
		await (await instance.host()).waitForSettlement(submissionId, context);
		await instance.waitForIdle(context);
	};
	return {
		database,
		instance,
		start,
		ask,
		async history(size: number) {
			for (let n = 0; n < size; n++) await ask(`question ${n}`);
		},
	};
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

interface Measurement {
	readonly scenario: string;
	readonly size: number;
	readonly pi: Rows;
	readonly flue: Rows;
}

const measurements: Measurement[] = [];

async function measure(database: { rows: Rows }, run: () => Promise<void>): Promise<Rows> {
	const before = { ...database.rows };
	await run();
	return delta(before, database.rows);
}

function record(scenario: string, size: number, pi: Rows, flue: Rows): void {
	measurements.push({ scenario, size, pi, flue });
	const overhead = delta(pi, flue);
	console.log(
		`[storage-budget] ${scenario} @${size}: pi read ${pi.rowsRead} written ${pi.rowsWritten}; flue read ${flue.rowsRead} written ${flue.rowsWritten}; overhead read ${overhead.rowsRead} written ${overhead.rowsWritten}`,
	);
}

afterEach(async () => {
	for (const instance of instances) await instance.close().catch(() => {});
	instances.length = 0;
	control.model = 'fast/m';
});

afterAll(async () => {
	resetModelsForTests();
	await removeTempFiles();
});

describe('storage budget: Flue over bare Pi Durable', () => {
	for (const size of SIZES) {
		it(`at history size ${size}`, { timeout: 600_000 }, async () => {
			const { fast, slow } = providers();
			setProvider(fast.provider);
			setProvider(slow.provider);
			const log = new InMemoryDurableStreamLog();

			// Bare Pi, the same work.
			const piFile = await tempFile(`pi-${size}.sqlite`);
			const pi = await bareHarness(piFile);
			await pi.history(size);
			const piRows: Record<string, Rows> = {};
			await pi.root.configure({ model: { provider: 'slow', modelId: 'm' } }, context);
			piRows['plain answer (~30 partials)'] = await measure(pi.database, () => pi.ask('stream'));
			await pi.root.configure({ model: { provider: 'fast', modelId: 'm' } }, context);
			piRows['5-tool-call turn'] = await measure(pi.database, () => pi.ask('tools 5'));
			piRows['A2A send (sender turn)'] = await measure(pi.database, () => pi.ask('send budget/x'));
			piRows['A2A receive (doorbell, pump, admission, turn)'] = await measure(pi.database, () =>
				pi.ask('hello'),
			);
			piRows['idle wake'] = await measure(pi.database, async () => {
				pi.harness.resume();
				await pi.harness.inspect(context);
			});
			await pi.close();
			// Cold: a new process over the same database (an evicted Durable Object's next wake).
			const reopened = await bareHarness(piFile);
			const piStatements = reopened.database.traceStatements();
			await reopened.ask('hello');
			console.log(
				`[storage-budget] bare Pi cold open @${size} by statement:\n  ${topStatements(piStatements).join('\n  ')}`,
			);
			piRows['cold open + admission + turn'] = { ...reopened.database.rows };
			await reopened.close();
			// A cold process over a one-turn conversation, one tool round: what the
			// cold store() turn (a one-turn conversation too) is measured against.
			const piStoreFile = await tempFile(`pi-store-${size}.sqlite`);
			const piStore = await bareHarness(piStoreFile);
			await piStore.ask('hello');
			await piStore.close();
			const piStoreCold = await bareHarness(piStoreFile);
			await piStoreCold.ask('tools 1');
			piRows['Code Mode store() turn, cold, after <size> store writes'] = {
				...piStoreCold.database.rows,
			};
			await piStoreCold.close();
			// A warm turn with one tool round, and idle wakes: the parked question's baselines.
			const reopenedAgain = await bareHarness(piFile);
			piRows['parked question (ask, park, answer, resume)'] = await measure(
				reopenedAgain.database,
				() => reopenedAgain.ask('tools 1'),
			);
			piRows['3 idle wakes while a question is parked'] = await measure(
				reopenedAgain.database,
				async () => {
					for (let n = 0; n < 3; n++) {
						reopenedAgain.harness.resume();
						await reopenedAgain.harness.inspect(context);
					}
				},
			);
			await reopenedAgain.close();

			// Flue.
			const aliceFile = await tempFile(`alice-${size}.sqlite`);
			const alice = await flueInstance(log, `alice-${size}`, aliceFile);
			await alice.history(size);
			const bob = await flueInstance(log, `bob-${size}`);
			await bob.history(size);
			const flueRows: Record<string, Rows> = {};
			control.model = 'slow/m';
			flueRows['plain answer (~30 partials)'] = await measure(alice.database, () =>
				alice.ask('stream'),
			);
			control.model = 'fast/m';
			flueRows['5-tool-call turn'] = await measure(alice.database, () => alice.ask('tools 5'));
			flueRows['A2A send (sender turn)'] = await measure(alice.database, () =>
				alice.ask(`send budget/bob-${size}`),
			);
			const bobInbox = inboxPath({ type: 'budget', id: `bob-${size}` });
			flueRows['A2A receive (doorbell, pump, admission, turn)'] = await measure(
				bob.database,
				async () => {
					await bob.instance.ring(bobInbox, (await log.head(bobInbox))?.nextOffset ?? '-1');
					const wake = await bob.instance.wake({ kind: 'pump' });
					expect(wake.pump?.admitted).toHaveLength(1);
					await bob.instance.waitForIdle(context);
				},
			);
			flueRows['idle wake'] = await measure(alice.database, async () => {
				await alice.instance.wake({ kind: 'live-tasks' });
			});

			// A Code Mode approval parks a question (rule 9): ask and park, wait, answer, resume.
			let parkedQuestion = '';
			let parkedSubmission = '';
			const parking = await measure(alice.database, async () => {
				parkedSubmission = await alice.start('approve it');
				await alice.instance.waitForIdle(context);
				parkedQuestion = (await alice.instance.pendingQuestions())[0]?.id ?? '';
			});
			flueRows['3 idle wakes while a question is parked'] = await measure(
				alice.database,
				async () => {
					for (let n = 0; n < 3; n++) await alice.instance.wake({ kind: 'live-tasks' });
				},
			);
			const answering = await measure(alice.database, async () => {
				const answered = await alice.instance.answerQuestion(parkedQuestion, {
					kind: 'codemode-approval',
					decision: 'approve',
				});
				expect(answered.status).toBe('accepted');
				const wake = await alice.instance.wake({ kind: 'pump' });
				expect(wake.pump?.answered).toEqual([parkedQuestion]);
				await (await alice.instance.host()).waitForSettlement(parkedSubmission, context);
				await alice.instance.waitForIdle(context);
			});
			flueRows['parked question (ask, park, answer, resume)'] = {
				rowsRead: parking.rowsRead + answering.rowsRead,
				rowsWritten: parking.rowsWritten + answering.rowsWritten,
			};
			expect(await alice.instance.pendingQuestions()).toEqual([]);
			// The public conversation is served from the cache: the streamed answer is in it.
			const head = await alice.instance.source.head();
			expect(head.snapshot?.messages.some((message) => message.role === 'assistant')).toBe(true);
			await alice.instance.close();
			const cold = await flueInstance(log, `alice-${size}`, aliceFile);
			const statements = cold.database.traceStatements();
			flueRows['cold open + admission + turn'] = await measure(cold.database, async () => {
				await cold.instance.wake({ kind: 'live-tasks' });
				await cold.ask('hello');
			});
			console.log(
				`[storage-budget] Flue cold open @${size} by statement:\n  ${topStatements(statements).join('\n  ')}`,
			);
			// A clean close leaves the cache usable: the cold start did not rebuild it.
			expect((await cold.instance.source.head()).incarnation).toBe(head.incarnation);

			// Code Mode store(): `size` earlier writes of the store, then a cold store() turn.
			const carolFile = await tempFile(`carol-${size}.sqlite`);
			const carol = await flueInstance(log, `carol-${size}`, carolFile);
			await carol.ask('hello');
			const carolHost = await carol.instance.host();
			for (let n = 0; n < size; n++) {
				await carolHost.harness.commit(async (tx) => {
					(await tx.doc(FlueCodemodeStore, ROOT_CONVERSATION_ID)).values.k = n + 1;
				}, context);
			}
			await carol.instance.close();
			const carolCold = await flueInstance(log, `carol-${size}`, carolFile);
			flueRows['Code Mode store() turn, cold, after <size> store writes'] = await measure(
				carolCold.database,
				async () => {
					await carolCold.instance.wake({ kind: 'live-tasks' });
					await carolCold.ask('store it');
				},
			);
			const stored = await (
				await carolCold.instance.host()
			).harness.snapshot(FlueCodemodeStore, ROOT_CONVERSATION_ID, context);
			expect(stored?.values.k).toBe(size + 1);

			for (const scenario of Object.keys(BUDGET)) {
				record(scenario, size, piRows[scenario] as Rows, flueRows[scenario] as Rows);
			}
		});
	}

	it('stays within the allowance, the same at every history size', () => {
		const overheads = new Map<string, Rows[]>();
		for (const measurement of measurements) {
			const overhead = delta(measurement.pi, measurement.flue);
			const budget = BUDGET[measurement.scenario] as Rows;
			const label = `${measurement.scenario} @${measurement.size}`;
			expect(overhead.rowsRead, `${label}: rows read over Pi`).toBeLessThanOrEqual(budget.rowsRead);
			expect(overhead.rowsWritten, `${label}: rows written over Pi`).toBeLessThanOrEqual(
				budget.rowsWritten,
			);
			overheads.set(measurement.scenario, [
				...(overheads.get(measurement.scenario) ?? []),
				overhead,
			]);
		}
		for (const [scenario, [small, large]] of overheads) {
			if (!small || !large) continue;
			// Streaming timing moves a partial or two between runs; history must not move anything.
			// Bounded, amortized costs land in a measured window or not: the cache's
			// checkpoint (one row every CHECKPOINT_EVERY pages, and up to that many
			// pages refolded by a cold start) and a document's base (every
			// DELTAS_PER_BASE changes, replacing that many revisions). None grows with
			// history; the slack covers where in its cycle each one happens to be.
			const slack = scenario.startsWith('cold open')
				? CHECKPOINT_EVERY + 2 * (DELTAS_PER_BASE + 1)
				: 2 * (DELTAS_PER_BASE + 1);
			expect(
				Math.abs(large.rowsRead - small.rowsRead),
				`${scenario}: rows read over Pi at size 1000 vs 10`,
			).toBeLessThanOrEqual(slack);
			expect(
				Math.abs(large.rowsWritten - small.rowsWritten),
				`${scenario}: rows written over Pi at size 1000 vs 10`,
			).toBeLessThanOrEqual(slack);
		}
	});
});
