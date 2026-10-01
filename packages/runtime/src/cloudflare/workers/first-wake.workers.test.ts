/**
 * What a new entity's first wake costs in Durable Object SQLite, as workerd
 * counts it — rows scanned, which is what Cloudflare bills — on the object a
 * generated entry builds (`first-wake.ts`: Flue over the Agents SDK's
 * `Agent`). The scenario is the society's scale run (nymph-ai/nymphai #3868):
 * a parent spawns a child, so the child's inbox holds one spawn message; the
 * Worker's wake route rings the child's doorbell; its alarm pumps the inbox,
 * admits the birth, and the turn answers in one short sentence. Then the
 * live-task backstop that turn armed fires once.
 *
 * Every statement is reported (`[first-wake]` lines) with its rows, and
 * attributed by the tables it names (`statementOwner`). The budget holds
 * Flue's own statements tight, and the total — Agents SDK and Pi included,
 * since that is the bill — loosely, so a dependency that changes what a
 * birth costs is seen.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import { spawnedUid } from '../../entity/facet.ts';
import { eventsPath, inboxPath } from '../../entity/paths.ts';
import { ElectricDurableStreamLog } from '../../streams/electric-log.ts';
import { STREAMS_ROOT, streamsServer } from './first-wake.ts';
import { formatTrace, sqlTrace, type TraceSummary } from './sql-trace.ts';

type WakeStub = DurableObjectStub & {
	__flueWake(doorbell: { stream: string; head: string }): Promise<{ recorded: true }>;
};

const namespace = (env as unknown as { FIRST_WAKE: DurableObjectNamespace }).FIRST_WAKE;

type Rows = { rowsRead: number; rowsWritten: number };

/**
 * Measured 2026-10-01 at 733 read / 275 written in all: Agents SDK 430 / 53
 * and 14 / 1 key-value keys, Pi 263 / 201, Flue's tables 26 / 20. Before
 * nymph-ai/nymphai #3868: 1,086 / 302, with Flue's tables at 38 / 47 and
 * `hasPiState` reading the whole schema (45 rows at the address, 80 at the
 * backstop).
 */
const BUDGET: { total: Rows; flue: Rows; piStateChecks: number } = {
	/** Every row of the four phases, key-value keys included. */
	total: { rowsRead: 800, rowsWritten: 300 },
	/** Statements on Flue's own tables. */
	flue: { rowsRead: 35, rowsWritten: 25 },
	/** Rows Pi-owned statements read outside the turn (the address and the backstop). */
	piStateChecks: 10,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settledSubmissions(stub: WakeStub): Promise<number> {
	return runInDurableObject(stub, (_instance, state) =>
		sqlTrace.unrecorded(() => {
			try {
				const row = state.storage.sql
					.exec("SELECT count(*) AS n FROM submissions WHERE status = 'done'")
					.one() as { n: number };
				return row.n;
			} catch {
				return 0;
			}
		}),
	);
}

/** Run due alarms and let the turn they admit finish, until `done` submissions settled. */
async function untilSettled(stub: WakeStub, done: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	while ((await settledSubmissions(stub)) < done) {
		if (Date.now() > deadline) throw new Error(`no ${done} settled submissions after 30 s`);
		await runDurableObjectAlarm(stub);
		await sleep(100);
	}
}

function take(label: string): TraceSummary {
	const summary = sqlTrace.summary();
	console.log(formatTrace(label, summary));
	sqlTrace.reset();
	return summary;
}

describe("a new entity's first wake on Durable Object SQLite (workerd)", () => {
	it(
		'spawn, doorbell, pump, admission, turn and the backstop wake',
		{ timeout: 60_000 },
		async () => {
			const parent = { type: 'alice', id: 'alice-i' };
			const child = { type: 'bob', id: `${parent.id}/kid0-0` };
			const log = new ElectricDurableStreamLog({
				baseUrl: STREAMS_ROOT,
				fetch: streamsServer.fetch,
			});
			await log.ensure(inboxPath(child));
			await log.ensure(eventsPath(child));
			const { nextOffset } = await log.append(inboxPath(child), [
				{
					type: 'flue.a2a.message',
					from: parent,
					messageId: `${parent.type}/${parent.id}/spawn/kid0-0`,
					message: { text: `You were spawned by alice "${parent.id}" as "kid0-0".` },
					directive: { kind: 'spawn', uid: await spawnedUid(child) },
				},
			]);

			sqlTrace.reset();
			const stub = (await getAgentByName(namespace as never, child.id)) as unknown as WakeStub;
			const phases: Record<string, TraceSummary> = {};
			phases.address = take('address (getAgentByName: construct, onStart)');
			await stub.__flueWake({ stream: inboxPath(child), head: nextOffset });
			phases.doorbell = take('doorbell (__flueWake)');
			await untilSettled(stub, 1);
			phases.birth = take('alarm: pump, birth admission, turn');
			// The live-task backstop the turn armed, made due now: in the Agents
			// SDK's schedule rows (0.20) or its job queue (0.23 on).
			await runInDurableObject(stub, (_instance, state) =>
				sqlTrace.unrecorded(() => {
					for (const table of ['cf_agents_schedules', 'cf_agents_jobs']) {
						try {
							state.storage.sql.exec(`UPDATE ${table} SET time = 0`).toArray();
						} catch {
							// Not this SDK version's table.
						}
					}
				}),
			);
			await runDurableObjectAlarm(stub);
			await sleep(200);
			phases.backstop = take('backstop alarm (live-tasks)');

			const total = Object.values(phases).reduce(
				(sum, phase) => ({
					rowsRead: sum.rowsRead + phase.rowsRead + phase.kv.read,
					rowsWritten: sum.rowsWritten + phase.rowsWritten + phase.kv.written,
				}),
				{ rowsRead: 0, rowsWritten: 0 },
			);
			console.log(
				`[first-wake] total (sql + kv keys): read ${total.rowsRead} written ${total.rowsWritten}; ${Object.entries(
					phases,
				)
					.map(
						([name, phase]) =>
							`${name} ${phase.rowsRead + phase.kv.read}r/${phase.rowsWritten + phase.kv.written}w`,
					)
					.join(', ')}`,
			);
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
			// The Agents SDK migrates its schema on a new object; no Flue table may
			// exist yet, or each of its schema scans reads it too.
			expect(
				phases.address?.byOwner.flue.rowsWritten,
				'Flue tables before the SDK',
			).toBeLessThanOrEqual(5);
			expect(
				(phases.address?.byOwner.pi.rowsRead ?? 0) + (phases.backstop?.byOwner.pi.rowsRead ?? 0),
				'rows read checking for Pi state',
			).toBeLessThanOrEqual(BUDGET.piStateChecks);
			expect(total.rowsRead, 'rows read in all').toBeLessThanOrEqual(BUDGET.total.rowsRead);
			expect(total.rowsWritten, 'rows written in all').toBeLessThanOrEqual(
				BUDGET.total.rowsWritten,
			);
		},
	);
});
