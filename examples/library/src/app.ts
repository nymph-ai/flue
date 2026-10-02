/**
 * Autonomous Knowledge Vault: a single Pi agent running Muse Spark,
 * maintaining an Obsidian-compatible knowledge base in Google Open Knowledge Format (OKF)
 * on Cloudflare R2, driven by Hacker News stream events over Electric.
 */
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Curator } from './agent.ts';
import { getOpenApiSpec } from './mcp/openapi.ts';
import { createMcpRouter } from './mcp/router.ts';
import { libraryModel } from './model.ts';
import { installQualification } from './qualification/install.ts';
import { createWikiRouter } from './wiki/routes.ts';

const app = new Hono<{ Bindings: Record<string, unknown> }>();

// Enable CORS across all endpoints for browser preflight, OpenAI ChatGPT plugins, and Dots
app.use(
	'*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		allowHeaders: [
			'Content-Type',
			'Authorization',
			'x-mcp-event-signature',
			'x-mcp-event-id',
			'x-mcp-task-id',
			'x-mcp-revision',
			'x-mcp-event-type',
		],
		exposeHeaders: [
			'x-mcp-event-signature',
			'x-mcp-event-id',
			'x-mcp-task-id',
			'x-mcp-revision',
			'x-mcp-event-type',
		],
	}),
);

// Global preflight handler
app.options('*', (c) => c.text('', 204));

app.get('/', (c) => {
	const origin = new URL(c.req.url).origin;
	return c.json({
		agent: 'curator',
		model: libraryModel(),
		streams: Boolean(c.env.FLUE_STREAMS_URL),
		mcp: '/mcp',
		wiki: '/wiki',
		manifest: '/wiki/manifest',
		gitInfo: '/wiki/git/info',
		gitToken: '/wiki/git/token',
		wellKnown: {
			aiPlugin: `${origin}/.well-known/ai-plugin.json`,
			mcp: `${origin}/.well-known/mcp.json`,
			openapi: `${origin}/openapi.json`,
		},
	});
});

// OpenAI Plugin Manifest for ChatGPT / Dots / Custom Actions
app.get('/.well-known/ai-plugin.json', (c) => {
	const origin = new URL(c.req.url).origin;
	return c.json({
		schema_version: 'v1',
		name_for_model: 'autonomous_knowledge_vault',
		name_for_human: 'Autonomous Knowledge Vault',
		description_for_model:
			'Autonomous Knowledge Vault in Google Open Knowledge Format (OKF) with MCP 2.0 (2026-07-28) and native MCP Events. Supports asynchronous long-running task submission (curation, literature synthesis, topic research), durable task storage in Cloudflare DO SQLite, signed HMAC webhook callback wake-ups, and verified OKF note retrieval.',
		description_for_human: 'Autonomous Knowledge Vault with MCP 2.0 and native MCP Events.',
		auth: {
			type: 'none',
		},
		api: {
			type: 'openapi',
			url: `${origin}/openapi.json`,
		},
		logo_url: `${origin}/logo.png`,
		contact_email: 'nympharum@proton.me',
		legal_info_url: `${origin}/wiki`,
	});
});

// MCP 2.0 Protocol Manifest
app.get('/.well-known/mcp.json', (c) => {
	const origin = new URL(c.req.url).origin;
	return c.json({
		$schema: 'https://modelcontextprotocol.io/schema/2026-07-28/mcp.json',
		name: 'library-knowledge-vault',
		version: '2.0.0',
		protocolVersion: '2026-07-28',
		transport: {
			type: 'http',
			endpoint: `${origin}/mcp`,
		},
		capabilities: {
			tools: { listChanged: false },
			events: { subscribe: true, list: true, history: true },
		},
		endpoints: {
			rpc: `${origin}/mcp`,
			tasks: `${origin}/mcp/tasks`,
			results: `${origin}/mcp/results`,
			events: `${origin}/mcp/events`,
			deliveries: `${origin}/mcp/deliveries`,
			testCallback: `${origin}/mcp/test-callback`,
		},
	});
});

// OpenAPI 3.1.0 specifications
app.get('/openapi.json', (c) => {
	const origin = new URL(c.req.url).origin;
	return c.json(getOpenApiSpec(origin));
});
app.get('/mcp/openapi.json', (c) => {
	const origin = new URL(c.req.url).origin;
	return c.json(getOpenApiSpec(origin));
});

// Wiki vault routes (public / accessible for Obsidian sync)
app.route('/wiki', createWikiRouter());

// MCP server endpoint for OpenAI Dots & external AI tools
app.route('/mcp', createMcpRouter());

// Agent route protected by bearer token
app.use('/agents/*', async (c, next) => {
	const token = c.env.LIBRARY_TOKEN as string | undefined;
	const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	if (typeof token !== 'string' || token.length === 0 || given !== token) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	await next();
});
app.use('/agent/*', async (c, next) => {
	const token = c.env.LIBRARY_TOKEN as string | undefined;
	const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	if (typeof token !== 'string' || token.length === 0 || given !== token) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	await next();
});

if (__QUALIFICATION__) installQualification(app as never);

// Single agent endpoints
app.route('/agent', createAgentRouter(Curator));
app.route('/agents/curator', createAgentRouter(Curator));

export default app;
