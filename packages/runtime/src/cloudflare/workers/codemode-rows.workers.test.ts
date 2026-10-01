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
import { linear } from './codemode-turn.ts';
import { formatTrace, sqlTrace, type TraceSummary } from './sql-trace.ts';
import { carol } from './turn-driver.ts';

type Rows = { rowsRead: number; rowsWritten: number };

/**
 * Measured 2026-10-01 (sql + key-value keys): the 10-call turn 610 read /
 * 218 written, the cold store() turn 617 / 234. On `@cloudflare/codemode`
 * the same turns cost 679 / 276 and 711 / 239, of which its facet's tables
 * 69 / 58 and 10 / 5 (BuildBuddy a9066d83-090a-40b4-9fb8-75a11f06cb30). The
 * ceilings leave a little room for the scheduler's polling.
 */
const BUDGET: Record<'tenCalls' | 'coldStore', Rows> = {
	tenCalls: { rowsRead: 650, rowsWritten: 230 },
	coldStore: { rowsRead: 650, rowsWritten: 245 },
};

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
		const { stub, say } = await carol('rows');
		sqlTrace.reset();

		const before = linear.calls.length;
		await say('Run ten calls.');
		const tenCalls = take('turn: one script, 10 MCP calls');
		expect(linear.calls.slice(before).filter((call) => call.name === 'list_comments')).toHaveLength(
			10,
		);

		await evictDurableObject(stub);
		sqlTrace.reset();
		await say('Now store it.');
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
