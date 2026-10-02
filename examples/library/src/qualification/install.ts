/**
 * The qualification surface of the library Worker, compiled in only by a
 * `QUALIFICATION=1` build (`vite.config.ts` defines `__QUALIFICATION__`) and
 * served only when the deployment also sets the `QUALIFICATION` var to "1".
 *
 * `/qual/*` admin routes, behind the `LIBRARY_TOKEN` bearer secret, inspect
 * and drive instances through their Durable Object RPC hooks
 * (`agent-hooks.ts`): storage cost, the wake book, forced evictions and
 * hand-rung doorbells.
 */
import {
	configuredStreams,
	configuredStreamsLog,
	inboxPath,
	streamsSubscriptions,
} from '@flue/runtime/qualification';
import type { Hono } from 'hono';

type Vars = Record<string, unknown>;
type Result = Record<string, unknown>;

/** The RPC hooks `agent-hooks.ts` adds to every agent's Durable Object. */
interface AgentStub {
	__flueWake(doorbell: { stream: string; head: string }): Promise<Result>;
	__qualInspect(): Promise<Result>;
	__qualRecords(): Promise<Result>;
	__qualEvict(): Promise<Result>;
}

function enabled(source: Vars): boolean {
	return source.QUALIFICATION === '1';
}

function bindingOf(agent: string): string {
	return `FLUE_${agent.replace(/-/g, '_').toUpperCase()}_AGENT`;
}

async function agentStub(source: Vars, agent: string, id: string): Promise<AgentStub> {
	const namespace = source[bindingOf(agent)];
	if (!namespace) throw new Error(`no agent "${agent}"`);
	return (namespace as DurableObjectNamespace).getByName(id) as unknown as AgentStub;
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

export function installQualification(app: Hono): void {
	app.use('/qual/*', async (c, next) => {
		const source = c.env as Vars;
		if (!enabled(source)) return c.json({ error: 'qualification is off' }, 404);
		const token = (source.LIBRARY_TOKEN ?? source.SOCIETY_TOKEN) as string | undefined;
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
			model: (source.LIBRARY_MODEL ?? source.SOCIETY_MODEL ?? 'scripted') as string,
			streams: streams ? { baseUrl: streams.baseUrl, webhook: streams.webhook ?? null } : null,
			version: (source.CF_VERSION_METADATA as { id?: string; tag?: string } | undefined) ?? null,
		});
	});

	app.get('/qual/inspect/:agent/:id', async (c) => {
		const stub = await agentStub(c.env as Vars, c.req.param('agent'), c.req.param('id'));
		return c.json(await stub.__qualInspect());
	});

	app.get('/qual/records/:agent/:id', async (c) => {
		const stub = await agentStub(c.env as Vars, c.req.param('agent'), c.req.param('id'));
		return c.json(await stub.__qualRecords());
	});

	app.post('/qual/evict/:agent/:id', async (c) => {
		const stub = await agentStub(c.env as Vars, c.req.param('agent'), c.req.param('id'));
		const outcome = await settled(() => stub.__qualEvict());
		return c.json({ evicted: true, outcome });
	});

	// Read-only: a stream's tail, through the configured log.
	app.get('/qual/stream-head', async (c) => {
		const path = c.req.query('path');
		const log = configuredStreamsLog(c.env as Vars);
		if (!path || !log) return c.json({ error: 'path and streams required' }, 400);
		return c.json({ path, head: await log.head(path) });
	});

	// Read-only: up to 200 messages of a stream from an offset, through the configured log.
	app.get('/qual/stream-read', async (c) => {
		const path = c.req.query('path');
		const from = c.req.query('from') ?? '-1';
		const log = configuredStreamsLog(c.env as Vars);
		if (!path || !log) return c.json({ error: 'path and streams required' }, 400);
		const batch = await settled(() => log.read(path, from as never));
		if ('error' in batch) return c.json({ path, ...batch });
		return c.json({
			path,
			messages: batch.messages.slice(0, 200),
			nextOffset: batch.nextOffset,
			upToDate: batch.upToDate,
		});
	});

	// Ring an entity's doorbell by hand: the same `__flueWake({ stream, head })`
	// RPC the wake route makes for a verified Electric webhook, for the given
	// streams (default: the entity's inbox) at their current tails. Only the
	// webhook hop is replaced; the alarm pumps exactly as it would for a real
	// wake. Used only when the server cannot deliver webhooks.
	app.post('/qual/wake/:agent/:id', async (c) => {
		const source = c.env as Vars;
		const agent = c.req.param('agent');
		const id = c.req.param('id');
		const log = configuredStreamsLog(source);
		if (!log) return c.json({ error: 'streams required' }, 400);
		const body = (await c.req.json().catch(() => ({}))) as { streams?: string[] };
		const paths = body.streams ?? [inboxPath({ type: agent, id })];
		const stub = await agentStub(source, agent, id);
		const rung = [];
		for (const stream of paths) {
			const head = (await log.head(stream))?.nextOffset;
			if (head === undefined) continue;
			rung.push({ stream, head, result: await stub.__flueWake({ stream, head }) });
		}
		return c.json({ rung });
	});

	// Read-only: GET/HEAD a URL through the FLUE_STREAMS binding (what host a
	// VPC service binding routes, whatever the URL names).
	app.get('/qual/vpc-probe', async (c) => {
		const streams = configuredStreams(c.env as Vars);
		const url = c.req.query('url');
		if (!streams?.fetch || !url) return c.json({ error: 'streams and url required' }, 400);
		const response = await settled(() =>
			(streams.fetch as NonNullable<typeof streams.fetch>)(url, { method: 'HEAD' }),
		);
		if ('error' in response) return c.json(response);
		return c.json({
			url,
			status: response.status,
			nextOffset: response.headers.get('stream-next-offset'),
		});
	});

	// Ensure the shared inbox subscription now and report the outcome (the
	// Worker also does this on its first request, but only logs a failure).
	app.post('/qual/ensure-inbox', async (c) => {
		const streams = configuredStreams(c.env as Vars);
		const url = streams?.webhook?.url;
		if (!streams || !url)
			return c.json({ error: 'streams and FLUE_STREAMS_WEBHOOK_URL required' }, 400);
		return c.json(await settled(() => streamsSubscriptions(streams, url).ensureInbox()));
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
