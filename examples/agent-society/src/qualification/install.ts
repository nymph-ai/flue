/**
 * The qualification surface of the society Worker, compiled in only by a
 * `QUALIFICATION=1` build (`vite.config.ts` defines `__QUALIFICATION__`) and
 * served only when the deployment also sets the `QUALIFICATION` var to "1".
 *
 * - Streams go through `faultInjectingFetch` (`faults.ts`), so a Pi log
 *   publish can be crashed on purpose.
 * - `/qual/*` admin routes, behind the `SOCIETY_TOKEN` bearer secret, inspect
 *   and drive instances through their Durable Object RPC hooks
 *   (`agent-hooks.ts`) and the scratch `QualReplica` object (`replica.ts`).
 */
import { env } from 'cloudflare:workers';
import { electricStreams, setStreams } from '@flue/runtime';
import {
	configuredStreams,
	configuredStreamsLog,
	diffDigests,
	type EntityAddress,
} from '@flue/runtime/qualification';
import { getAgentByName } from 'agents';
import type { Hono } from 'hono';
import { faultInjectingFetch, isFaultPlan } from './faults.ts';

type Vars = Record<string, unknown>;
type Stub = Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;

const vars = env as unknown as Vars;

function enabled(source: Vars = vars): boolean {
	return source.QUALIFICATION === '1';
}

/** Route Electric traffic through the fault injector (module scope, before any request). */
function installStreams(): void {
	const baseUrl = vars.FLUE_STREAMS_URL;
	const binding = vars.FLUE_STREAMS as
		{ fetch?: (input: unknown, init?: unknown) => Promise<Response> } | undefined;
	if (!enabled() || typeof baseUrl !== 'string' || !binding?.fetch) return;
	const jwksUrl = vars.FLUE_STREAMS_JWKS_URL;
	const webhookUrl = vars.FLUE_STREAMS_WEBHOOK_URL;
	setStreams(
		electricStreams({
			baseUrl,
			fetch: faultInjectingFetch(
				(input, init) => binding.fetch?.call(binding, input, init) as Promise<Response>,
			),
			webhook: {
				...(typeof jwksUrl === 'string' && jwksUrl ? { jwksUrl } : {}),
				...(typeof webhookUrl === 'string' && webhookUrl ? { url: webhookUrl } : {}),
			},
		}),
	);
}

function bindingOf(agent: string): string {
	return `FLUE_${agent.replace(/-/g, '_').toUpperCase()}_AGENT`;
}

async function agentStub(source: Vars, agent: string, id: string): Promise<Stub> {
	const namespace = source[bindingOf(agent)];
	if (!namespace) throw new Error(`no agent "${agent}"`);
	return (await getAgentByName(namespace as never, id)) as unknown as Stub;
}

function replica(source: Vars, name: string): Stub {
	const namespace = source.QUAL_REPLICA as DurableObjectNamespace | undefined;
	if (!namespace) throw new Error('no QUAL_REPLICA binding');
	return namespace.get(namespace.idFromName(name)) as unknown as Stub;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

async function settled<T>(run: () => Promise<T>): Promise<T | { error: string }> {
	try {
		return await run();
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function installQualification(app: Hono): void {
	installStreams();

	app.use('/qual/*', async (c, next) => {
		const source = c.env as Vars;
		if (!enabled(source)) return c.json({ error: 'qualification is off' }, 404);
		const token = source.SOCIETY_TOKEN;
		const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
		if (typeof token !== 'string' || token.length < 32 || !timingSafeEqual(given, token)) {
			return c.json({ error: 'unauthorized' }, 401);
		}
		await next();
	});

	app.get('/qual/health', (c) => {
		const source = c.env as Vars;
		const streams = configuredStreams(source);
		return c.json({
			ok: true,
			qualification: enabled(source),
			model: source.SOCIETY_MODEL ?? 'scripted',
			streams: streams ? { baseUrl: streams.baseUrl, webhook: streams.webhook ?? null } : null,
			version: (source.CF_VERSION_METADATA as { id?: string; tag?: string } | undefined) ?? null,
		});
	});

	app.get('/qual/inspect/:agent/:id', async (c) => {
		const stub = await agentStub(c.env as Vars, c.req.param('agent'), c.req.param('id'));
		return c.json(await stub.__qualInspect());
	});

	app.post('/qual/fault/:agent/:id', async (c) => {
		const plan: unknown = await c.req.json();
		if (!isFaultPlan(plan)) return c.json({ error: 'invalid fault plan' }, 400);
		const stub = await agentStub(c.env as Vars, c.req.param('agent'), c.req.param('id'));
		return c.json(await stub.__qualArmFault(plan));
	});

	app.post('/qual/evict/:agent/:id', async (c) => {
		const stub = await agentStub(c.env as Vars, c.req.param('agent'), c.req.param('id'));
		const outcome = await settled(() => stub.__qualEvict());
		return c.json({ evicted: true, outcome });
	});

	// Rebuild an instance's Pi index from its log alone, in a scratch object,
	// and compare every Pi read with the live instance's.
	app.get('/qual/compare/:agent/:id', async (c) => {
		const source = c.env as Vars;
		const agent = c.req.param('agent');
		const id = c.req.param('id');
		const waitMs = Math.min(60_000, Number(c.req.query('wait') ?? '20000'));
		const stub = await agentStub(source, agent, id);
		const deadline = Date.now() + waitMs;
		let live = await stub.__qualSnapshot();
		while (Number(live.pending) > 0 && Date.now() < deadline) {
			await sleep(500);
			live = await stub.__qualSnapshot();
		}
		if (Number(live.pending) > 0)
			return c.json({ equal: false, reason: 'outbox did not drain', live }, 409);
		const entity: EntityAddress = { type: agent, id };
		const rebuilt = await replica(source, `rebuild/${agent}/${id}/${crypto.randomUUID()}`).rebuild(
			entity,
			live.lastSeq,
		);
		const diff = diffDigests(
			(live.keys ?? {}) as Record<string, string>,
			(rebuilt.keys ?? {}) as Record<string, string>,
		);
		return c.json({
			equal: live.digest === rebuilt.digest && diff.length === 0,
			liveSeq: live.lastSeq,
			publishedSeq: live.publishedSeq,
			rebuiltSeq: rebuilt.rebuiltSeq,
			liveDigest: live.digest,
			rebuiltDigest: rebuilt.digest,
			keys: Object.keys((live.keys ?? {}) as object).length,
			diff: diff.slice(0, 25),
			rebuildMs: rebuilt.ms,
		});
	});

	app.get('/qual/log/:agent/:id', async (c) => {
		const agent = c.req.param('agent');
		const id = c.req.param('id');
		return c.json(
			await replica(c.env as Vars, `log/${agent}/${id}/${crypto.randomUUID()}`).logSeqs({
				type: agent,
				id,
			}),
		);
	});

	app.post('/qual/producer-probe', async (c) => {
		const body = (await c.req.json()) as { path?: string };
		const path = body.path ?? `qual/producer-probe/${crypto.randomUUID()}`;
		return c.json(await replica(c.env as Vars, `probe/${path}`).producerProbe(path));
	});

	app.post('/qual/split-brain/:agent/:id', async (c) => {
		const agent = c.req.param('agent');
		const id = c.req.param('id');
		return c.json(
			await replica(c.env as Vars, `split/${agent}/${id}/${crypto.randomUUID()}`).splitBrain({
				type: agent,
				id,
			}),
		);
	});

	// Read-only: a stream's tail, through the configured log.
	app.get('/qual/stream-head', async (c) => {
		const path = c.req.query('path');
		const log = configuredStreamsLog(c.env as Vars);
		if (!path || !log) return c.json({ error: 'path and streams required' }, 400);
		return c.json({ path, head: await log.head(path) });
	});

	// Read-only: a subscription as the agents-server reports it.
	app.get('/qual/subscription/:id', async (c) => {
		const streams = configuredStreams(c.env as Vars);
		if (!streams?.fetch) return c.json({ error: 'streams required' }, 400);
		const response = await streams.fetch(
			`${streams.baseUrl.replace(/\/+$/, '')}/__ds/subscriptions/${encodeURIComponent(c.req.param('id'))}`,
		);
		const text = await response.text();
		let body: unknown = text;
		try {
			// Nothing secret is expected here; anything token-shaped is dropped anyway.
			body = JSON.parse(text, (key, value) =>
				/secret|token|private/i.test(key) ? '[redacted]' : value,
			);
		} catch {}
		return c.json({ status: response.status, body });
	});
}
