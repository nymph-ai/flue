/**
 * Test-only fault injection in front of the Electric log, compiled in only by
 * a `QUALIFICATION=1` build. It wraps the `fetch` the configured streams use
 * (the `FLUE_STREAMS` VPC binding) and acts on POSTs to an instance's Pi log
 * (`flue/v1/{agent}/{id}/pi`) — the commit outbox publishing one Pi commit —
 * according to the plan armed on that instance (`__qualArmFault`):
 *
 * - `crash-before-post` (after N appends): the commit is in the Durable
 *   Object's SQLite (synced), the POST never leaves, the instance is aborted.
 * - `crash-after-post` (after N appends): the POST lands on Electric, the
 *   instance is aborted before it learns the outcome.
 * - `abort-after-commits` N: after N Pi commits are acknowledged in this
 *   incarnation, the instance is aborted — wherever its turn is.
 *
 * A plan fires once: it is deleted and the deletion synced before the abort,
 * so the next incarnation runs clean. "Aborted" is `ctx.abort()`: the object's
 * memory is discarded mid-flight, exactly as an eviction or crash does.
 */

export type FaultKind = 'crash-before-post' | 'crash-after-post' | 'abort-after-commits';

export interface FaultPlan {
	readonly kind: FaultKind;
	/** Appends to let through first (`abort-after-commits`: acknowledged commits). */
	readonly after: number;
}

export function isFaultPlan(value: unknown): value is FaultPlan {
	const plan = value as Partial<FaultPlan> | null;
	return (
		typeof plan === 'object' &&
		plan !== null &&
		(plan.kind === 'crash-before-post' ||
			plan.kind === 'crash-after-post' ||
			plan.kind === 'abort-after-commits') &&
		typeof plan.after === 'number' &&
		Number.isInteger(plan.after) &&
		plan.after >= 0
	);
}

export interface QualifiedInstance {
	readonly key: string;
	readonly ctx: DurableObjectState;
	readonly boot: string;
	/** Pi log POSTs seen / acknowledged in this incarnation since the plan was armed. */
	attempts: number;
	acknowledged: number;
	resetCounters(): void;
}

const instances = new Map<string, QualifiedInstance>();

export function registerInstance(
	key: string,
	ctx: DurableObjectState,
	boot: string,
): QualifiedInstance {
	const existing = instances.get(key);
	if (existing && existing.ctx === ctx) return existing;
	const instance: QualifiedInstance = {
		key,
		ctx,
		boot,
		attempts: 0,
		acknowledged: 0,
		resetCounters() {
			this.attempts = 0;
			this.acknowledged = 0;
		},
	};
	instances.set(key, instance);
	return instance;
}

/** `…/flue/v1/{agent}/{id}/pi` (wire form) → `{agent}/{id}`, or undefined. */
export function piLogOwner(pathname: string): string | undefined {
	const segments = pathname.split('/').filter((segment) => segment.length > 0);
	const at = segments.lastIndexOf('flue');
	if (at < 0 || segments.length !== at + 5) return undefined;
	if (segments[at + 1] !== 'v1' || segments[at + 4] !== 'pi') return undefined;
	try {
		// Wire segments are encoded twice: once as log-path segments, once in the URL.
		const agent = decodeURIComponent(decodeURIComponent(segments[at + 2] as string));
		const id = decodeURIComponent(decodeURIComponent(segments[at + 3] as string));
		return `${agent}/${id}`;
	} catch {
		return undefined;
	}
}

function readPlan(ctx: DurableObjectState): FaultPlan | undefined {
	try {
		const row = ctx.storage.sql
			.exec('SELECT kind, after FROM qual_faults WHERE one = 1')
			.toArray()[0];
		return row ? { kind: row.kind as FaultKind, after: Number(row.after) } : undefined;
	} catch {
		return undefined;
	}
}

async function fire(
	instance: QualifiedInstance,
	plan: FaultPlan,
	detail: Record<string, unknown>,
): Promise<never> {
	const { ctx } = instance;
	ctx.storage.sql.exec('DELETE FROM qual_faults WHERE one = 1');
	ctx.storage.sql.exec(
		'INSERT INTO qual_activity (at, kind, boot, detail) VALUES (?, ?, ?, ?)',
		Date.now(),
		'fault-fired',
		instance.boot,
		JSON.stringify({ ...plan, ...detail }),
	);
	// Everything committed so far is durable before the process "dies".
	await ctx.storage.sync();
	instances.delete(instance.key);
	ctx.abort(`qualification fault: ${plan.kind}`);
	throw new Error(`qualification fault: ${plan.kind}`);
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** Wrap the streams `fetch` with the armed fault plans of the instances in this isolate. */
export function faultInjectingFetch(inner: Fetch): Fetch {
	return async (input, init) => {
		const method = (
			init?.method ?? (input instanceof Request ? input.method : 'GET')
		).toUpperCase();
		if (method !== 'POST') return inner(input, init);
		const url = new URL(input instanceof Request ? input.url : String(input));
		const owner = piLogOwner(url.pathname);
		const instance = owner ? instances.get(owner) : undefined;
		const plan = instance ? readPlan(instance.ctx) : undefined;
		if (!instance || !plan) return inner(input, init);
		instance.attempts++;
		const detail = {
			path: url.pathname,
			attempt: instance.attempts,
			seq: init?.headers ? new Headers(init.headers).get('stream-seq') : null,
		};
		if (plan.kind === 'crash-before-post' && instance.attempts > plan.after) {
			return fire(instance, plan, detail);
		}
		const response = await inner(input, init);
		if (plan.kind === 'crash-after-post' && instance.attempts > plan.after) {
			return fire(instance, plan, { ...detail, status: response.status });
		}
		if (
			plan.kind === 'abort-after-commits' &&
			(response.status === 200 || response.status === 204)
		) {
			instance.acknowledged++;
			if (instance.acknowledged >= plan.after) {
				return fire(instance, plan, { ...detail, status: response.status });
			}
		}
		return response;
	};
}
