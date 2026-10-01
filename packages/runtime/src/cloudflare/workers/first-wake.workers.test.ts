/**
 * What an entity's wakes cost in Durable Object SQLite, as workerd counts
 * it — rows scanned, which is what Cloudflare bills — on the objects a
 * generated entry builds (`first-wake.ts`: Flue over `DurableObject` and the
 * Agents SDK's `Lifecycle`), and the properties those objects keep.
 *
 * - A new entity's first wake (nymph-ai/nymphai #3868): a parent spawns a
 *   child, so the child's inbox holds one spawn message; the Worker's wake
 *   route rings the child's doorbell; its wake pumps the inbox, admits the
 *   birth, and the turn answers in one short sentence. Then the live-task
 *   backstop that turn armed fires once.
 * - Per scenario, on one entity with tools and Code Mode: an agent-to-agent
 *   receive, a streamed answer, a 5-tool-call turn, a duplicate doorbell and
 *   an idle wake, and a cold `store()` turn after an eviction.
 * - Properties: the pump drains in bounded chunks and re-runs itself while
 *   behind; a replayed send (same message id) is admitted once; a turn
 *   evicted mid-stream resumes from its armed wake; a Code Mode approval
 *   parks, survives eviction, and resumes exactly once when answered.
 *
 * Every statement is reported (`[first-wake]` lines) with its rows, and
 * attributed by the tables it names (`statementOwner`); `[rows]` lines are
 * the per-scenario table.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { spawnedUid } from '../../entity/facet.ts';
import { eventsPath, inboxPath } from '../../entity/paths.ts';
import { PUMP_LIMITS } from '../../entity/pump.ts';
import { ElectricDurableStreamLog } from '../../streams/electric-log.ts';
import {
	armLaterWake,
	makeWakesDue,
	STREAMS_ROOT,
	sends,
	streamsServer,
	stubFor,
} from './first-wake.ts';
import { formatTrace, sqlTrace, statementOwner, type TraceSummary } from './sql-trace.ts';

type WakeStub = DurableObjectStub & {
	__flueWake(doorbell: { stream: string; head: string }): Promise<{ recorded: true }>;
};

const namespaces = env as unknown as {
	FIRST_WAKE: DurableObjectNamespace;
	ROWS: DurableObjectNamespace;
};

type Rows = { rowsRead: number; rowsWritten: number };

/**
 * Measured 2026-10-01 (billed: SQL rows, key-value keys, one row written per
 * `setAlarm`). On the Agents SDK 0.20.1 `Agent`: 713 read / 277 written,
 * the SDK's own share 414 / 53 and 11 / 1 key-value keys; before
 * nymph-ai/nymphai #3868, 1,086 / 302. On a plain Durable Object with the
 * 0.24 `Lifecycle` and Flue's own alarm: 285 / 223, the SDK's share nothing.
 */
const BUDGET: { total: Rows; flue: Rows; piStateChecks: number } = {
	/** Every billed row of the phases. */
	total: { rowsRead: 330, rowsWritten: 240 },
	/** Statements on Flue's own tables. */
	flue: { rowsRead: 35, rowsWritten: 25 },
	/** Rows Pi-owned statements read outside the turn (the backstop). */
	piStateChecks: 10,
};

/**
 * Per scenario, the same harness on the Agents SDK 0.20.1 `Agent` measured
 * 2026-10-01: none may cost more now. (Measured on the 0.24 `Lifecycle` with
 * Flue's alarm: receive 170 / 100, streamed 432 / 286, tools 567 / 367, cold
 * store() 470 / 236.)
 */
const BEFORE: Record<string, Rows> = {
	receive: { rowsRead: 220, rowsWritten: 103 },
	streamed: { rowsRead: 482, rowsWritten: 289 },
	tools: { rowsRead: 617, rowsWritten: 370 },
	store: { rowsRead: 552, rowsWritten: 245 },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const log = new ElectricDurableStreamLog({ baseUrl: STREAMS_ROOT, fetch: streamsServer.fetch });

function count(stub: DurableObjectStub, query: string): Promise<number> {
	return runInDurableObject(stub, (_instance, state) =>
		sqlTrace.unrecorded(() => {
			try {
				return (state.storage.sql.exec(query).one() as { n: number }).n;
			} catch {
				return 0;
			}
		}),
	);
}

const settledSubmissions = (stub: DurableObjectStub) =>
	count(stub, "SELECT count(*) AS n FROM submissions WHERE status = 'done'");

/**
 * Run the object's alarm if it is due — as the platform would; Miniflare's
 * `runDurableObjectAlarm` runs a scheduled alarm whenever it is asked, early
 * or not, and an early run is a wake production never pays for.
 */
async function runDueAlarm(stub: DurableObjectStub): Promise<boolean> {
	const due = await runInDurableObject(stub, async (_instance, state) => {
		const at = await sqlTrace.unrecorded(() => state.storage.getAlarm());
		return at !== null && at <= Date.now();
	});
	return due ? runDurableObjectAlarm(stub) : false;
}

/** Run due alarms and let the turn they admit finish, until `done` submissions settled. */
async function untilSettled(stub: DurableObjectStub, done: number, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while ((await settledSubmissions(stub)) < done) {
		if (Date.now() > deadline)
			throw new Error(`no ${done} settled submissions after ${timeoutMs} ms`);
		await runDueAlarm(stub);
		await sleep(100);
	}
}

/**
 * Evict the object as a crash or a redeploy would: `ctx.abort()` drops its
 * memory and whatever it was running, mid-turn included, and keeps its
 * storage (the society's `__qualEvict` does the same live). Miniflare's
 * graceful `evictDurableObject` instead waits for in-flight work to drain.
 */
async function evict(
	stub: DurableObjectStub,
	namespace: DurableObjectNamespace,
): Promise<DurableObjectStub> {
	const id = stub.id;
	await runInDurableObject(stub, (_instance, state) => state.abort('test: evicted')).catch(
		() => {},
	);
	// A stub whose object was reset is broken; address it again.
	return namespace.get(id);
}

/** Make the armed wake due and run it; `false` when nothing was armed. */
async function fireArmedWake(stub: DurableObjectStub): Promise<boolean> {
	const armed = await runInDurableObject(stub, (_instance, state) => makeWakesDue(state));
	if (armed) await runDurableObjectAlarm(stub);
	await sleep(200);
	return armed;
}

function take(label: string): TraceSummary {
	const summary = sqlTrace.summary();
	console.log(formatTrace(label, summary, 40));
	sqlTrace.reset();
	return summary;
}

/** What Cloudflare bills: SQL rows, key-value keys, and one row written per `setAlarm`. */
const billed = (phase: TraceSummary): Rows => ({
	rowsRead: phase.rowsRead + phase.kv.read,
	rowsWritten: phase.rowsWritten + phase.kv.written + phase.alarms,
});

function report(scenario: string, phase: TraceSummary): void {
	const rows = billed(phase);
	console.log(
		`[rows] ${scenario}: read ${rows.rowsRead} written ${rows.rowsWritten} (sql ${phase.rowsRead}/${phase.rowsWritten}, kv keys ${phase.kv.read}/${phase.kv.written}, setAlarm ${phase.alarms}; agents-sdk ${phase.byOwner['agents-sdk'].rowsRead}/${phase.byOwner['agents-sdk'].rowsWritten}, flue ${phase.byOwner.flue.rowsRead}/${phase.byOwner.flue.rowsWritten}, pi ${phase.byOwner.pi.rowsRead}/${phase.byOwner.pi.rowsWritten})`,
	);
}

/** An inbox message from alice; `spawn` births the receiver. */
async function deliver(
	to: { type: string; id: string },
	messageId: string,
	text: string,
	options: { spawn?: boolean } = {},
): Promise<string> {
	await log.ensure(inboxPath(to));
	await log.ensure(eventsPath(to));
	const { nextOffset } = await log.append(inboxPath(to), [
		{
			type: 'flue.a2a.message',
			from: { type: 'alice', id: 'alice-i' },
			messageId,
			message: { text },
			...(options.spawn ? { directive: { kind: 'spawn', uid: await spawnedUid(to) } } : {}),
		},
	]);
	return nextOffset;
}

/** Deliver a message and ring the doorbell, as the Worker's wake route does. */
async function receive(
	stub: WakeStub,
	to: { type: string; id: string },
	messageId: string,
	text: string,
	options: { spawn?: boolean } = {},
): Promise<string> {
	const head = await deliver(to, messageId, text, options);
	await stub.__flueWake({ stream: inboxPath(to), head });
	return head;
}

describe("a new entity's first wake on Durable Object SQLite (workerd)", () => {
	it(
		'spawn, doorbell, pump, admission, turn and the backstop wake',
		{ timeout: 60_000 },
		async () => {
			const child = { type: 'bob', id: 'alice-i/kid0-0' };
			const head = await deliver(
				child,
				'alice/alice-i/spawn/kid0-0',
				'You were spawned by alice "alice-i" as "kid0-0".',
				{
					spawn: true,
				},
			);

			sqlTrace.reset();
			const stub = (await stubFor(namespaces.FIRST_WAKE, child.id)) as WakeStub;
			const phases: Record<string, TraceSummary> = {};
			await stub.__flueWake({ stream: inboxPath(child), head });
			phases.doorbell = take('doorbell (__flueWake: construct, start, ring)');
			await untilSettled(stub, 1);
			phases.birth = take('alarm: pump, birth admission, turn');
			// The live-task backstop the turn armed, made due now.
			await fireArmedWake(stub);
			phases.backstop = take('backstop wake (live-tasks)');

			const total = Object.values(phases).reduce(
				(sum, phase) => ({
					rowsRead: sum.rowsRead + billed(phase).rowsRead,
					rowsWritten: sum.rowsWritten + billed(phase).rowsWritten,
				}),
				{ rowsRead: 0, rowsWritten: 0 },
			);
			console.log(
				`[first-wake] total (sql + kv keys + setAlarm): read ${total.rowsRead} written ${total.rowsWritten}; ${Object.entries(
					phases,
				)
					.map(
						([name, phase]) => `${name} ${billed(phase).rowsRead}r/${billed(phase).rowsWritten}w`,
					)
					.join(', ')}`,
			);
			report('first wake of a new entity (doorbell, birth turn, backstop)', {
				...phases.birth,
				rowsRead: Object.values(phases).reduce((n, phase) => n + phase.rowsRead, 0),
				rowsWritten: Object.values(phases).reduce((n, phase) => n + phase.rowsWritten, 0),
				kv: {
					read: Object.values(phases).reduce((n, phase) => n + phase.kv.read, 0),
					written: Object.values(phases).reduce((n, phase) => n + phase.kv.written, 0),
				},
				alarms: Object.values(phases).reduce((n, phase) => n + phase.alarms, 0),
				alarmDeletes: Object.values(phases).reduce((n, phase) => n + phase.alarmDeletes, 0),
				byOwner: Object.fromEntries(
					(['agents-sdk', 'flue', 'pi'] as const).map((owner) => [
						owner,
						Object.values(phases).reduce(
							(sum, phase) => ({
								rowsRead: sum.rowsRead + phase.byOwner[owner].rowsRead,
								rowsWritten: sum.rowsWritten + phase.byOwner[owner].rowsWritten,
							}),
							{ rowsRead: 0, rowsWritten: 0 },
						),
					]),
				) as TraceSummary['byOwner'],
			});
			expect(await settledSubmissions(stub)).toBe(1);
			expect(phases.birth?.statements.length).toBeGreaterThan(0);
			const flue = Object.values(phases).reduce(
				(sum, phase) => ({
					rowsRead: sum.rowsRead + phase.byOwner.flue.rowsRead,
					rowsWritten: sum.rowsWritten + phase.byOwner.flue.rowsWritten,
				}),
				{ rowsRead: 0, rowsWritten: 0 },
			);
			expect(flue.rowsRead, 'rows Flue read').toBeLessThanOrEqual(BUDGET.flue.rowsRead);
			expect(flue.rowsWritten, 'rows Flue wrote').toBeLessThanOrEqual(BUDGET.flue.rowsWritten);
			expect(
				phases.backstop?.byOwner.pi.rowsRead ?? 0,
				'rows read checking for Pi state',
			).toBeLessThanOrEqual(BUDGET.piStateChecks);
			// No Agent base class and no job queue: the Agents SDK touches no table.
			expect(
				Object.values(phases).flatMap((phase) =>
					phase.statements.filter(([sql]) => statementOwner(sql) === 'agents-sdk'),
				),
				'Agents SDK statements in a first wake',
			).toEqual([]);
			expect(total.rowsRead, 'rows read in all').toBeLessThanOrEqual(BUDGET.total.rowsRead);
			expect(total.rowsWritten, 'rows written in all').toBeLessThanOrEqual(
				BUDGET.total.rowsWritten,
			);
		},
	);
});

describe('rows per scenario on an entity with tools and Code Mode (workerd)', () => {
	it(
		'receive, stream, 5 tool calls, idle wakes and a cold store() turn',
		{ timeout: 120_000 },
		async () => {
			const carol = { type: 'carol', id: 'carol-rows' };
			let stub = (await stubFor(namespaces.ROWS, carol.id)) as WakeStub;
			let settled = 0;
			const turn = async (scenario: string, messageId: string, text: string, spawn = false) => {
				sqlTrace.reset();
				await receive(stub, carol, messageId, text, { spawn });
				await untilSettled(stub, ++settled);
				// The turn's armed backstop, now that nothing is live: part of the turn's bill.
				await fireArmedWake(stub);
				const phase = take(scenario);
				report(scenario, phase);
				return phase;
			};

			await turn('birth (carol)', 'm-birth', 'hello', true);
			const receive2 = await turn(
				'agent-to-agent receive (doorbell, pump, admission, short turn)',
				'm-a2a',
				'hi again',
			);
			const streamed = await turn('streamed answer (~60 partials)', 'm-stream', 'stream please');
			const tools = await turn('5-tool-call turn', 'm-tools', 'tools 5');

			// A duplicate webhook for events already pumped: nothing to record, nothing to wake.
			sqlTrace.reset();
			const head = await runInDurableObject(stub, (_instance, state) =>
				sqlTrace.unrecorded(
					() =>
						(
							state.storage.sql
								.exec('SELECT head FROM flue_entity_streams WHERE path = ?', inboxPath(carol))
								.one() as { head: string }
						).head,
				),
			);
			await stub.__flueWake({ stream: inboxPath(carol), head });
			const duplicate = take('duplicate doorbell');
			report('idle wake: duplicate doorbell', duplicate);
			expect(duplicate.rowsWritten + duplicate.kv.written, 'a duplicate doorbell writes').toBe(0);
			expect(duplicate.alarms, 'a duplicate doorbell arms').toBe(0);

			// An idle wake: the alarm fires with nothing live (a wake armed for later, made due).
			await runInDurableObject(stub, (instance) => armLaterWake(instance));
			sqlTrace.reset();
			expect(await fireArmedWake(stub)).toBe(true);
			const idle = take('idle wake (armed wake, nothing live)');
			report('idle wake: armed wake with nothing live', idle);
			expect(billed(idle).rowsWritten, 'rows an idle wake writes').toBe(0);

			stub = (await evict(stub, namespaces.ROWS)) as WakeStub;
			const store = await turn(
				'cold store() turn (after an eviction)',
				'm-store',
				'store it',
			);

			for (const [scenario, phase] of [
				['receive', receive2],
				['streamed', streamed],
				['tools', tools],
				['store', store],
			] as const) {
				const before = BEFORE[scenario] as Rows;
				expect(billed(phase).rowsRead, `${scenario} rows read`).toBeLessThanOrEqual(
					before.rowsRead,
				);
				expect(billed(phase).rowsWritten, `${scenario} rows written`).toBeLessThanOrEqual(
					before.rowsWritten,
				);
				expect(phase.byOwner['agents-sdk'], `${scenario}: Agents SDK rows`).toEqual({
					rowsRead: 0,
					rowsWritten: 0,
				});
			}
		},
	);
});

describe('properties of the generated Durable Object (workerd)', () => {
	it(
		'the pump drains in bounded chunks and wakes itself again while behind',
		{ timeout: 120_000 },
		async () => {
			const dave = { type: 'carol', id: 'carol-burst' };
			const stub = (await stubFor(namespaces.ROWS, dave.id)) as WakeStub;
			const burst = PUMP_LIMITS.events + 3;
			const uid = await spawnedUid(dave);
			await log.ensure(inboxPath(dave));
			await log.ensure(eventsPath(dave));
			const { nextOffset } = await log.append(
				inboxPath(dave),
				Array.from({ length: burst }, (_, index) => ({
					type: 'flue.a2a.message',
					from: { type: 'alice', id: 'alice-i' },
					messageId: `burst-${index}`,
					message: { text: `message ${index}` },
					...(index === 0 ? { directive: { kind: 'spawn', uid } } : {}),
				})),
			);
			await stub.__flueWake({ stream: inboxPath(dave), head: nextOffset });
			const admitted = () => count(stub, 'SELECT count(*) AS n FROM submissions');
			const behind = () =>
				count(stub, 'SELECT count(*) AS n FROM flue_entity_streams WHERE cursor <> head');
			let alarms = 0;
			const deadline = Date.now() + 60_000;
			while ((await behind()) > 0) {
				if (Date.now() > deadline) throw new Error('the pump never caught up');
				await runDueAlarm(stub);
				alarms++;
				await sleep(50);
			}
			expect(await admitted()).toBe(burst);
			// Each wake admits at most PUMP_LIMITS.events; Miniflare may also run some itself.
			expect(alarms).toBeGreaterThanOrEqual(1);
		},
	);

	it('a replayed send (the same message id) is admitted once', { timeout: 60_000 }, async () => {
		const erin = { type: 'carol', id: 'carol-replay' };
		const stub = (await stubFor(namespaces.ROWS, erin.id)) as WakeStub;
		await receive(stub, erin, 'replayed-1', 'hello', { spawn: true });
		await receive(stub, erin, 'replayed-1', 'hello', { spawn: true });
		await untilSettled(stub, 1);
		await fireArmedWake(stub);
		expect(await count(stub, 'SELECT count(*) AS n FROM submissions')).toBe(1);
	});

	it('a turn evicted mid-stream resumes from its armed wake', { timeout: 120_000 }, async () => {
		const fay = { type: 'carol', id: 'carol-evicted' };
		let stub = (await stubFor(namespaces.ROWS, fay.id)) as WakeStub;
		await receive(stub, fay, 'm-birth', 'hello', { spawn: true });
		await untilSettled(stub, 1);
		await receive(stub, fay, 'm-slow', 'stream please');
		// Admit it and let it stream for a while.
		await runDueAlarm(stub);
		await sleep(1500);
		expect(await settledSubmissions(stub)).toBe(1);
		stub = (await evict(stub, namespaces.ROWS)) as WakeStub;
		// Nothing pokes the object but its own armed wake.
		const deadline = Date.now() + 60_000;
		while ((await settledSubmissions(stub)) < 2) {
			if (Date.now() > deadline) throw new Error('the evicted turn never resumed');
			await fireArmedWake(stub);
			await sleep(500);
		}
		expect(await count(stub, "SELECT count(*) AS n FROM submissions WHERE status <> 'done'")).toBe(
			0,
		);
	});

	it(
		'a Code Mode approval parks, survives eviction, and resumes exactly once',
		{ timeout: 120_000 },
		async () => {
			const gus = { type: 'carol', id: 'carol-question' };
			let stub = (await stubFor(namespaces.ROWS, gus.id)) as WakeStub;
			const base = `https://flue.test/agents/carol/${encodeURIComponent(gus.id)}`;
			await receive(stub, gus, 'm-birth', 'hello', { spawn: true });
			await untilSettled(stub, 1);
			sends.count = 0;
			await receive(stub, gus, 'm-approve', 'approve it');
			let questions: { id: string }[] = [];
			const deadline = Date.now() + 30_000;
			while (questions.length === 0) {
				if (Date.now() > deadline) throw new Error('no question parked');
				await runDueAlarm(stub);
				await sleep(200);
				questions = (
					(await (await stub.fetch(`${base}/questions`)).json()) as { questions: { id: string }[] }
				).questions;
			}
			expect(sends.count).toBe(0);
			stub = (await evict(stub, namespaces.ROWS)) as WakeStub;
			// Idle wakes while it waits change nothing.
			await fireArmedWake(stub);
			expect(sends.count).toBe(0);
			const question = questions[0] as { id: string };
			const answer = await stub.fetch(
				`${base}/questions/${encodeURIComponent(question.id)}/answer`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						answer: { kind: 'codemode-approval', decision: 'approve' },
						answerId: 'a1',
					}),
				},
			);
			expect(answer.status).toBe(202);
			await untilSettled(stub, 2);
			expect(sends.count).toBe(1);
			// Evicted again and woken again: the call does not run twice.
			stub = (await evict(stub, namespaces.ROWS)) as WakeStub;
			await fireArmedWake(stub);
			await fireArmedWake(stub);
			expect(sends.count).toBe(1);
			expect(
				((await (await stub.fetch(`${base}/questions`)).json()) as { questions: unknown[] })
					.questions,
			).toEqual([]);
		},
	);
});
