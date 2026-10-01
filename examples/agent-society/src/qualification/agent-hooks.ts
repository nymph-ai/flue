/**
 * Test-only Durable Object hooks for the society's agents, compiled in only by
 * a `QUALIFICATION=1` build (`hooks.ts`). They add RPC methods the admin
 * routes call and record what happens to each instance in its own SQLite
 * (`qual_activity`), so a doorbell, an alarm, an eviction or a boot is
 * countable per entity after the fact without waking it at the time.
 *
 * - `__qualInspect()`: the wake book (each stream's head and cursor), the
 *   conversation cache's identity and row, Pi's submission counts, the rows
 *   Flue's SQLite facade read and wrote since boot, and the activity log.
 * - `__qualRecords()`: raw Pi records, for diagnosis.
 * - `__qualEvict()`: `ctx.abort()` — the instance's memory is gone, its
 *   storage stays: a forced eviction.
 */
import { durableObjectRows } from '@flue/runtime/qualification';

type Row = Record<string, unknown>;

interface DurableObjectLike {
	readonly ctx: DurableObjectState;
	readonly name: string;
}

const ACTIVITY_SCHEMA = `CREATE TABLE IF NOT EXISTS qual_activity (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	kind TEXT NOT NULL,
	boot TEXT NOT NULL,
	detail TEXT
)`;

export function recordActivity(
	ctx: DurableObjectState,
	boot: string,
	kind: string,
	detail?: unknown,
): void {
	try {
		ctx.storage.sql.exec(ACTIVITY_SCHEMA);
		ctx.storage.sql.exec(
			'INSERT INTO qual_activity (at, kind, boot, detail) VALUES (?, ?, ?, ?)',
			Date.now(),
			kind,
			boot,
			detail === undefined ? null : JSON.stringify(detail),
		);
	} catch (error) {
		console.error('[society:qual] could not record activity', error);
	}
}

function rows(ctx: DurableObjectState, query: string, ...bindings: unknown[]): Row[] {
	try {
		return ctx.storage.sql.exec(query, ...(bindings as never[])).toArray() as Row[];
	} catch {
		return [];
	}
}

/** `FlueAliceAgent` → `alice`: the identity the class was generated for. */
export function agentOfClass(className: string): string {
	const name = className.replace(/^Flue/, '').replace(/Agent$/, '');
	return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

const boots = new WeakMap<object, { id: string; at: number }>();

function bootOf(instance: object): { id: string; at: number } {
	let boot = boots.get(instance);
	if (!boot) {
		boot = { id: crypto.randomUUID().slice(0, 8), at: Date.now() };
		boots.set(instance, boot);
	}
	return boot;
}

export function qualifiedBase(Base: new (...args: any[]) => any): new (...args: any[]) => any {
	return class QualifiedAgent extends Base {
		constructor(ctx: DurableObjectState, env: unknown) {
			super(ctx, env);
			recordActivity(ctx, bootOf(this).id, 'boot');
		}

		/** Raw Pi records for diagnosis: every submission, the newest tasks and entries. */
		async __qualRecords(): Promise<Record<string, unknown>> {
			const ctx = (this as unknown as DurableObjectLike).ctx;
			const parse = (list: Row[]) =>
				list.map((row) => ({ ...row, record: JSON.parse(String(row.record ?? 'null')) }));
			return {
				submissions: parse(rows(ctx, 'SELECT id, status, record FROM submissions ORDER BY id')),
				tasks: parse(
					rows(ctx, 'SELECT id, kind, status, record FROM tasks ORDER BY id DESC LIMIT 20'),
				),
				entries: parse(
					rows(
						ctx,
						'SELECT id, conversation_id, commit_seq, record FROM entries ORDER BY id DESC LIMIT 20',
					),
				),
			};
		}

		async __qualInspect(): Promise<Record<string, unknown>> {
			const self = this as unknown as DurableObjectLike;
			const ctx = self.ctx;
			recordActivity(ctx, bootOf(this).id, 'inspect');
			return {
				instance: `${agentOfClass(this.constructor.name)}/${self.name}`,
				boot: bootOf(this),
				rows: durableObjectRows(ctx.storage as never),
				streams: rows(ctx, 'SELECT path, head, cursor FROM flue_entity_streams ORDER BY path'),
				conversation:
					rows(ctx, 'SELECT identity, row FROM flue_conversation_state WHERE singleton = 1')[0] ??
					null,
				submissions: rows(
					ctx,
					'SELECT status, count(*) AS n FROM submissions GROUP BY status ORDER BY status',
				),
				tasks: rows(ctx, 'SELECT kind, status, count(*) AS n FROM tasks GROUP BY kind, status'),
				observed:
					rows(
						ctx,
						`SELECT count(*) AS n FROM entries WHERE record LIKE '%"kind":"flue.observed"%'`,
					)[0]?.n ?? 0,
				alarm: await ctx.storage.getAlarm(),
				activity: {
					counts: rows(
						ctx,
						'SELECT kind, count(*) AS n, min(at) AS first_at, max(at) AS last_at FROM qual_activity GROUP BY kind',
					),
					recent: rows(
						ctx,
						'SELECT id, at, kind, boot, detail FROM qual_activity ORDER BY id DESC LIMIT 40',
					),
				},
			};
		}

		async __qualEvict(): Promise<never> {
			const self = this as unknown as DurableObjectLike;
			recordActivity(self.ctx, bootOf(this).id, 'evict');
			await self.ctx.storage.sync();
			self.ctx.abort('qualification: forced eviction');
			throw new Error('evicted');
		}
	};
}

/** Count entries into the instance: the platform's ways in, recorded before they run. */
export function qualifiedWrap<T extends new (...args: any[]) => any>(Final: T): T {
	const prototype = Final.prototype as Record<string, unknown>;
	const enter = (instance: DurableObjectLike, kind: string, detail?: unknown) => {
		recordActivity(instance.ctx, bootOf(instance).id, kind, detail);
	};
	const wrap = (method: string, kind: string, describe?: (args: unknown[]) => unknown) => {
		const original = prototype[method];
		if (typeof original !== 'function') return;
		prototype[method] = function (this: DurableObjectLike, ...args: unknown[]) {
			enter(this, kind, describe?.(args));
			return (original as (...a: unknown[]) => unknown).apply(this, args);
		};
	};
	wrap('__flueWake', 'doorbell', (args) => args[0]);
	wrap('alarm', 'alarm');
	wrap(
		'onJob',
		'scheduled-wake',
		(args) => (args[0] as { job?: { id?: string } } | undefined)?.job?.id,
	);
	wrap('onRequest', 'request', (args) => {
		const request = args[0] as Request | undefined;
		return request ? `${request.method} ${new URL(request.url).pathname}` : undefined;
	});
	return Final;
}
