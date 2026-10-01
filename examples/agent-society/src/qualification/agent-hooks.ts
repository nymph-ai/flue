/**
 * Test-only Durable Object hooks for the society's agents, compiled in only by
 * a `QUALIFICATION=1` build (`hooks.ts`). They add RPC methods the admin
 * routes call and record what happens to each instance in its own SQLite
 * (`qual_activity`), so a wake, an eviction or a boot is countable per entity
 * after the fact without waking it at the time.
 *
 * - `__qualInspect()`: StreamStorage state (producer epoch, published seq,
 *   outbox and relay depth), the Pi index seq, cursors, and the activity log.
 * - `__qualSnapshot()`: digests of every Pi read of the live index.
 * - `__qualArmFault(plan)`: arm a crash in the Pi log publisher (`faults.ts`).
 * - `__qualEvict()`: `ctx.abort()` — the instance's memory is gone, its
 *   storage stays: a forced eviction.
 */
import {
	digestSnapshot,
	indexedSeq,
	snapshotDurableObjectIndex,
} from '@flue/runtime/qualification';
import { type FaultPlan, registerInstance, type QualifiedInstance } from './faults.ts';

type Row = Record<string, unknown>;

interface DurableObjectLike {
	readonly ctx: DurableObjectState;
	readonly name: string;
}

const ACTIVITY_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS qual_activity (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL,
		kind TEXT NOT NULL,
		boot TEXT NOT NULL,
		detail TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS qual_faults (
		one INTEGER PRIMARY KEY CHECK (one = 1),
		kind TEXT NOT NULL,
		after INTEGER NOT NULL,
		armed_at INTEGER NOT NULL
	)`,
];

function ensureSchema(ctx: DurableObjectState): void {
	for (const statement of ACTIVITY_SCHEMA) ctx.storage.sql.exec(statement);
}

export function recordActivity(
	ctx: DurableObjectState,
	boot: string,
	kind: string,
	detail?: unknown,
): void {
	try {
		ensureSchema(ctx);
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

function qualified(instance: DurableObjectLike): QualifiedInstance {
	const agent = agentOfClass(instance.constructor.name);
	const boot = bootOf(instance);
	return registerInstance(`${agent}/${instance.name}`, instance.ctx, boot.id);
}

export function qualifiedBase(Base: new (...args: any[]) => any): new (...args: any[]) => any {
	return class QualifiedAgent extends Base {
		constructor(ctx: DurableObjectState, env: unknown) {
			super(ctx, env);
			recordActivity(ctx, bootOf(this).id, 'boot');
		}

		/** Raw Pi records for diagnosis: every submission and task, the newest entries. */
		async __qualRecords(): Promise<Record<string, unknown>> {
			const ctx = (this as unknown as DurableObjectLike).ctx;
			const parse = (list: Row[]) =>
				list.map((row) => ({ ...row, record: JSON.parse(String(row.record ?? 'null')) }));
			return {
				submissions: parse(rows(ctx, 'SELECT id, status, record FROM submissions ORDER BY id')),
				tasks: parse(rows(ctx, 'SELECT id, kind, status, record FROM tasks ORDER BY id DESC LIMIT 20')),
				entries: parse(rows(ctx, 'SELECT id, conversation_id, commit_seq, record FROM entries ORDER BY id DESC LIMIT 20')),
			};
		}

		async __qualInspect(): Promise<Record<string, unknown>> {
			const self = this as unknown as DurableObjectLike;
			const ctx = self.ctx;
			qualified(self);
			recordActivity(ctx, bootOf(this).id, 'inspect');
			const producer = rows(ctx, 'SELECT * FROM flue_pi_producer')[0];
			const outbox = rows(
				ctx,
				'SELECT count(*) AS depth, min(seq) AS first_seq, max(seq) AS last_seq FROM flue_pi_outbox',
			)[0];
			const relay = rows(ctx, 'SELECT count(*) AS depth FROM flue_relay_outbox')[0];
			const counts = rows(
				ctx,
				'SELECT kind, count(*) AS n, min(at) AS first_at, max(at) AS last_at FROM qual_activity GROUP BY kind',
			);
			const boot = bootOf(this);
			return {
				instance: `${agentOfClass(this.constructor.name)}/${self.name}`,
				boot,
				producer: producer ?? null,
				outbox: outbox ?? null,
				relay: relay ?? null,
				indexedSeq: indexedSeq(ctx.storage.sql as never),
				cursors: rows(ctx, 'SELECT key, value FROM flue_entity_cursors ORDER BY key'),
				submissions: rows(
					ctx,
					'SELECT status, count(*) AS n FROM submissions GROUP BY status ORDER BY status',
				),
				activity: {
					counts,
					recent: rows(
						ctx,
						'SELECT id, at, kind, boot, detail FROM qual_activity ORDER BY id DESC LIMIT 40',
					),
				},
				fault: rows(ctx, 'SELECT * FROM qual_faults')[0] ?? null,
			};
		}

		/** Digests of every Pi read of the live index, when everything it holds is published. */
		async __qualSnapshot(): Promise<Record<string, unknown>> {
			const self = this as unknown as DurableObjectLike;
			const ctx = self.ctx;
			recordActivity(ctx, bootOf(this).id, 'snapshot');
			const lastSeq = indexedSeq(ctx.storage.sql as never);
			const producer = rows(ctx, 'SELECT published_seq FROM flue_pi_producer')[0];
			const pending = Number(rows(ctx, 'SELECT count(*) AS n FROM flue_pi_outbox')[0]?.n ?? 0);
			if (lastSeq === 0) return { lastSeq, publishedSeq: 0, pending, digest: null, keys: {} };
			const snapshot = await snapshotDurableObjectIndex(ctx.storage as never, lastSeq);
			const digests = await digestSnapshot(snapshot);
			return {
				lastSeq,
				publishedSeq: Number(producer?.published_seq ?? 0),
				pending,
				digest: digests.digest,
				keys: digests.keys,
			};
		}

		async __qualArmFault(plan: FaultPlan): Promise<Record<string, unknown>> {
			const self = this as unknown as DurableObjectLike;
			const ctx = self.ctx;
			ensureSchema(ctx);
			ctx.storage.sql.exec(
				'INSERT INTO qual_faults (one, kind, after, armed_at) VALUES (1, ?, ?, ?) ON CONFLICT (one) DO UPDATE SET kind = excluded.kind, after = excluded.after, armed_at = excluded.armed_at',
				plan.kind,
				plan.after,
				Date.now(),
			);
			const instance = qualified(self);
			instance.resetCounters();
			recordActivity(ctx, bootOf(this).id, 'fault-armed', plan);
			return { armed: plan, instance: instance.key };
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
		try {
			qualified(instance);
		} catch {
			// `name` is not known before the first named entry.
		}
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
	wrap('__flueWake', 'wake', (args) => {
		const request = args[0] as
			{ subscriptionId?: string; generation?: number; streams?: { path: string }[] } | undefined;
		return {
			subscription: request?.subscriptionId,
			generation: request?.generation,
			streams: request?.streams?.map((stream) => stream.path),
		};
	});
	wrap('__flueWakeAgentSubmissions', 'alarm-wake', (args) => args[0]);
	wrap('onRequest', 'request', (args) => {
		const request = args[0] as Request | undefined;
		return request ? `${request.method} ${new URL(request.url).pathname}` : undefined;
	});
	return Final;
}
