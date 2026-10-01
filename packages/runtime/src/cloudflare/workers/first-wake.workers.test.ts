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
 * Every statement is reported (`[first-wake]` lines) with its rows; the
 * budget below is the total, Agents SDK included, since that is the bill.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import { spawnedUid } from '../../entity/facet.ts';
import { eventsPath, inboxPath } from '../../entity/paths.ts';
import { ElectricDurableStreamLog } from '../../streams/electric-log.ts';
import { type FirstWakeAgent, STREAMS_ROOT, streamsServer } from './first-wake.ts';
import { formatTrace, sqlTrace, type TraceSummary } from './sql-trace.ts';

type WakeStub = DurableObjectStub<FirstWakeAgent> & {
	__flueWake(doorbell: { stream: string; head: string }): Promise<{ recorded: true }>;
};

const namespace = (env as unknown as { FIRST_WAKE: DurableObjectNamespace<FirstWakeAgent> })
	.FIRST_WAKE;

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
			// The live-task backstop the turn armed, made due now.
			await runInDurableObject(stub, (_instance, state) =>
				sqlTrace.unrecorded(() =>
					state.storage.sql.exec('UPDATE cf_agents_schedules SET time = 0').toArray(),
				),
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
		},
	);
});
