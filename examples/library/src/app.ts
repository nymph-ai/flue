/**
 * Autonomous Knowledge Vault: a single Pi agent running Muse Spark,
 * maintaining an Obsidian-compatible knowledge base in Google Open Knowledge Format (OKF)
 * on Cloudflare R2, driven by Hacker News stream events over Electric.
 */
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Curator } from './agent.ts';
import { createMcpRouter } from './mcp/router.ts';
import { libraryModel } from './model.ts';
import { installQualification } from './qualification/install.ts';
import { createWikiRouter } from './wiki/routes.ts';

const app = new Hono<{ Bindings: Record<string, unknown> }>();

app.get('/', (c) =>
	c.json({
		agent: 'curator',
		model: libraryModel(),
		streams: Boolean(c.env.FLUE_STREAMS_URL),
		mcp: '/mcp',
		wiki: '/wiki',
		manifest: '/wiki/manifest',
		gitInfo: '/wiki/git/info',
		gitToken: '/wiki/git/token',
	}),
);

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
