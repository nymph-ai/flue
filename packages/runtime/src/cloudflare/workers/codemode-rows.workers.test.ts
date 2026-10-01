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
 * names (`statementOwner`). `codemode` is `@cloudflare/codemode`'s runtime
 * facet (`cm_*` tables), which Code Mode used before it ran Pi's sandbox
 * in-process; it must stay at zero.
 */
import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { notesMcp } from './codemode-turn.ts';
import { formatTrace, sqlTrace, type TraceSummary } from './sql-trace.ts';
import { dora } from './turn-driver.ts';

type Rows = { rowsRead: number; rowsWritten: number };

/**
 * Billed rows measured 2026-10-01 on the Agents SDK 0.24 `Lifecycle`: the
 * 10-call turn 342 read / 219 written, the cold store() turn 421 / 232
 * (BuildBuddy f6beb3ca-b899-47fa-b493-7371bdc4b51c). On `@cloudflare/codemode`
 * and the SDK 0.20 `Agent` the same turns cost 679 / 276 and 711 / 239, of
 * which the Code Mode facet's own tables 69 / 58 and 10 / 5 — rows this
 * design never writes (BuildBuddy a9066d83-090a-40b4-9fb8-75a11f06cb30).
 */
const BUDGET: Record<'tenCalls' | 'coldStore', Rows> = {
	tenCalls: { rowsRead: 380, rowsWritten: 235 },
	coldStore: { rowsRead: 460, rowsWritten: 250 },
};

function take(label: string): TraceSummary {
	const summary = sqlTrace.summary();
	console.log(formatTrace(`[codemode-rows] ${label}`, summary).replace('[first-wake] ', ''));
	sqlTrace.reset();
	return summary;
}

/** Billed rows: SQL rows, key-value keys, and a row written per `setAlarm`. */
const total = (summary: TraceSummary): Rows => ({
	rowsRead: summary.rowsRead + summary.kv.read,
	rowsWritten: summary.rowsWritten + summary.kv.written + summary.alarms,
});

describe('a Code Mode turn on Durable Object SQLite (workerd)', () => {
	it('10 MCP calls in one script, and a cold store() turn', { timeout: 60_000 }, async () => {
		const { stub, say } = await dora('rows');
		sqlTrace.reset();

		const before = notesMcp.calls.length;
		await say('Run ten calls.');
		const tenCalls = take('turn: one script, 10 MCP calls');
		expect(notesMcp.calls.slice(before).filter((call) => call.name === 'get_note')).toHaveLength(
			10,
		);

		await evictDurableObject(stub);
		sqlTrace.reset();
		await say('Now store it.');
		const coldStore = take('cold store() turn (after an eviction)');

		const rows = { tenCalls: total(tenCalls), coldStore: total(coldStore) };
		console.log(
			`[codemode-rows] totals (billed): ${Object.entries(rows)
				.map(([name, value]) => `${name} ${value.rowsRead}r/${value.rowsWritten}w`)
				.join(', ')}; codemode tables: ${Object.entries({ tenCalls, coldStore })
				.map(
					([name, value]) =>
						`${name} ${value.byOwner.codemode.rowsRead}r/${value.byOwner.codemode.rowsWritten}w`,
				)
				.join(', ')}`,
		);
		for (const summary of [tenCalls, coldStore]) {
			expect(summary.byOwner.codemode).toEqual({ rowsRead: 0, rowsWritten: 0 });
		}
		for (const [name, budget] of Object.entries(BUDGET) as [keyof typeof BUDGET, Rows][]) {
			expect(rows[name].rowsRead, `${name}: rows read`).toBeLessThanOrEqual(budget.rowsRead);
			expect(rows[name].rowsWritten, `${name}: rows written`).toBeLessThanOrEqual(
				budget.rowsWritten,
			);
		}
	});
});
