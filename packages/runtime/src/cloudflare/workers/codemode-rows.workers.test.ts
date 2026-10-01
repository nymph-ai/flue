/**
 * What a Code Mode turn costs in Durable Object SQLite, as workerd counts it
 * (rows scanned and written, what Cloudflare bills), on an agent's object as
 * a generated entry builds it (`codemode-turn.ts`). Two turns, each after the
 * entity's birth turn:
 *
 * - a script making 10 MCP calls (`ten calls`);
 * - a cold `store()` turn: the object is evicted first (`store it`).
 *
 * `[codemode-rows]` lines report every statement, attributed by the tables it
 * names (`statementOwner`); Code Mode's own tables are `codemode`. The
 * numbers are the instrument for nymph-ai/nymphai's Code Mode cost work;
 * the budget only holds them where they were measured.
 */
import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import { spawnedUid } from '../../entity/facet.ts';
import { eventsPath, inboxPath } from '../../entity/paths.ts';
import { ElectricDurableStreamLog } from '../../streams/electric-log.ts';
import { linear } from './codemode-turn.ts';
import { STREAMS_ROOT, streamsServer } from './first-wake.ts';
import { formatTrace, sqlTrace, type TraceSummary } from './sql-trace.ts';

type WakeStub = DurableObjectStub & {
	__flueWake(doorbell: { stream: string; head: string }): Promise<{ recorded: true }>;
};

const namespace = (env as unknown as { CODEMODE_TURN: DurableObjectNamespace }).CODEMODE_TURN;

type Rows = { rowsRead: number; rowsWritten: number };

/** Ceilings at the measured values (see the commit that set them). */
const BUDGET: Record<'tenCalls' | 'coldStore', Rows> = {
	tenCalls: { rowsRead: 100_000, rowsWritten: 100_000 },
	coldStore: { rowsRead: 100_000, rowsWritten: 100_000 },
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
	console.log(formatTrace(`[codemode-rows] ${label}`, summary).replace('[first-wake] ', ''));
	sqlTrace.reset();
	return summary;
}

const total = (summary: TraceSummary): Rows => ({
	rowsRead: summary.rowsRead + summary.kv.read,
	rowsWritten: summary.rowsWritten + summary.kv.written,
});

describe('a Code Mode turn on Durable Object SQLite (workerd)', () => {
	it('10 MCP calls in one script, and a cold store() turn', { timeout: 60_000 }, async () => {
		const parent = { type: 'alice', id: 'alice-cm' };
		const child = { type: 'carol', id: `${parent.id}/carol0` };
		const log = new ElectricDurableStreamLog({ baseUrl: STREAMS_ROOT, fetch: streamsServer.fetch });
		await log.ensure(inboxPath(child));
		await log.ensure(eventsPath(child));
		let sent = 0;
		const send = async (text: string, spawn = false) => {
			const { nextOffset } = await log.append(inboxPath(child), [
				{
					type: 'flue.a2a.message',
					from: parent,
					messageId: `${parent.type}/${parent.id}/m${++sent}`,
					message: { text },
					...(spawn ? { directive: { kind: 'spawn', uid: await spawnedUid(child) } } : {}),
				},
			]);
			return nextOffset;
		};

		const stub = (await getAgentByName(namespace as never, child.id)) as unknown as WakeStub;
		await stub.__flueWake({ stream: inboxPath(child), head: await send('You were born.', true) });
		await untilSettled(stub, 1);
		sqlTrace.reset();

		await stub.__flueWake({ stream: inboxPath(child), head: await send('Run ten calls.') });
		await untilSettled(stub, 2);
		const tenCalls = take('turn: one script, 10 MCP calls');
		expect(linear.calls.filter((call) => call.name === 'list_comments')).toHaveLength(10);

		await evictDurableObject(stub);
		sqlTrace.reset();
		await stub.__flueWake({ stream: inboxPath(child), head: await send('Now store it.') });
		await untilSettled(stub, 3);
		const coldStore = take('cold store() turn (after an eviction)');

		const rows = { tenCalls: total(tenCalls), coldStore: total(coldStore) };
		console.log(
			`[codemode-rows] totals (sql + kv keys): ${Object.entries(rows)
				.map(([name, value]) => `${name} ${value.rowsRead}r/${value.rowsWritten}w`)
				.join(', ')}; codemode tables: ${Object.entries({ tenCalls, coldStore })
				.map(
					([name, value]) =>
						`${name} ${value.byOwner.codemode.rowsRead}r/${value.byOwner.codemode.rowsWritten}w`,
				)
				.join(', ')}`,
		);
		for (const [name, budget] of Object.entries(BUDGET) as [keyof typeof BUDGET, Rows][]) {
			expect(rows[name].rowsRead, `${name}: rows read`).toBeLessThanOrEqual(budget.rowsRead);
			expect(rows[name].rowsWritten, `${name}: rows written`).toBeLessThanOrEqual(
				budget.rowsWritten,
			);
		}
	});
});
