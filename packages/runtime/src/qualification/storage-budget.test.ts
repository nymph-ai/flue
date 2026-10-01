/**
 * BASELINE (the log-based storage this lane replaced), measured like the
 * storage budget of the Cloudflare-native storage.
 *
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
import { createRegistry, Harness, type ToolRegistration } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { context, textOf } from '../entity/a2a-test-support.ts';
import { removeTempFiles, tempFile } from '../pi/stream-storage-test-support.ts';
import { inboxPath } from '../entity/paths.ts';
import { useModel } from '../hooks/use-model.ts';
import { useTool } from '../hooks/use-tool.ts';
import { createMcpConnectionCache } from '../mcp.ts';
import { openNodeSqliteDatabase } from '../node/node-sqlite-database.ts';
import type { SqliteDatabase, SqliteStatement } from '@earendil-works/pi-durable/storage/sqlite';
import { FlueAgentInstance } from '../runtime/agent-instance.ts';
import { InMemoryAttachmentStore } from '../runtime/attachment-store.ts';
import { resetModelsForTests, setProvider } from '../runtime/providers.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import type { Agent } from '../types.ts';

type Rows = { rowsRead: number; rowsWritten: number };

/** BASELINE: counts rows the way Flue's facade does — rows changed, rows returned. */
class Counting implements SqliteDatabase {
	readonly rows: Rows = { rowsRead: 0, rowsWritten: 0 };
	statements: Map<string, Rows> | undefined;
	constructor(private readonly inner: SqliteDatabase) {}
	traceStatements(): Map<string, Rows> {
		this.statements ??= new Map();
		return this.statements;
	}
	exec(sql: string): void {
		this.inner.exec(sql);
	}
	prepare(sql: string): SqliteStatement {
		const raw = (
			this.inner as unknown as {
				database: {
					prepare(sql: string): {
						run(...a: unknown[]): { changes: number | bigint };
						get(...a: unknown[]): unknown;
						all(...a: unknown[]): unknown[];
					};
				};
			}
		).database.prepare(sql);
		const count = (read: number, written: number) => {
			this.rows.rowsRead += read;
			this.rows.rowsWritten += written;
			if (!this.statements) return;
			const counters = this.statements.get(sql) ?? { rowsRead: 0, rowsWritten: 0 };
			counters.rowsRead += read;
			counters.rowsWritten += written;
			this.statements.set(sql, counters);
		};
		return {
			run: (...params) => {
				count(0, Number(raw.run(...params).changes));
			},
			get: (...params) => {
				const row = raw.get(...params);
				count(row === undefined ? 0 : 1, 0);
				return row as never;
			},
			all: (...params) => {
				const all = raw.all(...params);
				count(all.length, 0);
				return all as never;
			},
		};
	}
	transaction<T>(callback: () => T): T | Promise<T> {
		return this.inner.transaction(callback);
	}
	close(): void | Promise<void> {
		return this.inner.close();
	}
}


const SIZES = [10, 1000] as const;
const STREAM_TOKENS_PER_SECOND = 100;
/** ~30 partials: Pi commits a partial every 100 ms; 300 four-character tokens stream for 3 s. */
const STREAMED_TEXT = 'abcd'.repeat(300);

/**
 * Flue's allowance over bare Pi, per scenario. Every one is a fixed number
 * of rows; none may depend on the history size (asserted separately).
 */
const BUDGET: Record<string, Rows> = {
	'plain answer (~30 partials)': { rowsRead: 120, rowsWritten: 60 },
	'5-tool-call turn': { rowsRead: 160, rowsWritten: 80 },
	'A2A send (sender turn)': { rowsRead: 140, rowsWritten: 70 },
	'A2A receive (doorbell, pump, admission, turn)': { rowsRead: 160, rowsWritten: 80 },
	'idle wake': { rowsRead: 30, rowsWritten: 0 },
	'cold open + admission + turn': { rowsRead: 200, rowsWritten: 80 },
};

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
	const registry = createRegistry<ToolRegistration>();
	registry.tools.add({
		name: 'probe',
		description: 'Probe.',
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
	});
	registry.tools.add({
		name: 'send_message',
		description: 'Send.',
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async () => ({ content: [{ type: 'text', text: 'sent' }] }),
	});
	const database = new Counting(await openNodeSqliteDatabase(file));
	const storage = await SqliteStorage.open(database);
	const harness = await Harness.open(storage, { models, registry }, context);
	const root = await harness.root(context);
	if ((await root.getModel(context))?.provider !== 'fast')
		await root.setModel({ provider: 'fast', modelId: 'm' }, context);
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
	return 'You are a budget probe.';
}) as unknown as Agent;

const instances: FlueAgentInstance[] = [];

async function flueInstance(log: InMemoryDurableStreamLog, id: string, file = ':memory:') {
	const database = new Counting(await openNodeSqliteDatabase(file));
	const instance = new FlueAgentInstance({
		agentName: 'budget',
		instanceId: id,
		agent: BudgetAgent,
		database: () => database,
		log,
		publish: 'await',
		attachments: new InMemoryAttachmentStore(),
		armWake: () => {},
		events: { emitEvent: () => ({}) } as never,
		mcp: createMcpConnectionCache(),
		entities: {},
	});
	instances.push(instance);
	let counter = Date.now();
	const ask = async (body: string) => {
		const submissionId = `sub_${id}_${counter++}`;
		await instance.admit({
			kind: 'direct',
			submissionId,
			message: { kind: 'user', body },
			acceptedAt: new Date().toISOString(),
		});
		await (await instance.host()).waitForSettlement(submissionId, context);
		await instance.waitForIdle(context);
	};
	return {
		database,
		instance,
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
			await pi.root.setModel({ provider: 'slow', modelId: 'm' }, context);
			piRows['plain answer (~30 partials)'] = await measure(pi.database, () => pi.ask('stream'));
			await pi.root.setModel({ provider: 'fast', modelId: 'm' }, context);
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
					await alice.instance.waitForIdle(context);
					const wake = await bob.instance.wakeEntity({
						subscriptionId: 'budget',
						generation: Date.now(),
						streams: [{ path: bobInbox, tailOffset: (await log.head(bobInbox))?.nextOffset ?? '-1' }],
					});
					expect(wake.admitted).toHaveLength(1);
					await bob.instance.waitForIdle(context);
				},
			);
			flueRows['idle wake'] = await measure(alice.database, async () => {
				await alice.instance.wake({ kind: 'live-tasks' });
			});
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

			for (const scenario of Object.keys(BUDGET)) {
				record(scenario, size, piRows[scenario] as Rows, flueRows[scenario] as Rows);
			}
		});
	}

	it.skip('stays within the allowance, the same at every history size', () => {
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
			// The cache's checkpoint is one row every 16 pages: a window may or may not hold one.
			const slack = scenario.startsWith('plain answer') ? 4 : 2;
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
