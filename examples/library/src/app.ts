/**
 * The Autonomous Knowledge Library: curators and librarians on Pi Durable,
 * an Obsidian-compatible knowledge base structured in Google Open Knowledge Format (OKF),
 * with real-time ingress over Electric streams and persistent storage.
 *
 * The agent routes are behind the `LIBRARY_TOKEN` (or `SOCIETY_TOKEN`) bearer secret.
 * The wiki routes (`/wiki/*`) expose the Obsidian vault, markdown notes, manifest,
 * and 1-click vault download (`/wiki/vault.zip`).
 */
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Alice } from './agents/alice.ts';
import { Bob } from './agents/bob.ts';
import { Curator } from './agents/curator.ts';
import { Librarian } from './agents/librarian.ts';
import { Sage } from './agents/sage.ts';
import { Steward } from './agents/steward.ts';
import { libraryModel } from './model.ts';
import { installQualification } from './qualification/install.ts';
import { createWikiRouter } from './wiki/routes.ts';

const app = new Hono<{ Bindings: Record<string, unknown> }>();

app.get('/', (c) =>
	c.json({
		library: ['curator', 'librarian', 'steward', 'sage', 'alice', 'bob'],
		model: libraryModel(),
		streams: Boolean(c.env.FLUE_STREAMS_URL),
		wiki: '/wiki',
		vaultZip: '/wiki/vault.zip',
		manifest: '/wiki/manifest',
	}),
);

// Wiki vault routes (public / accessible for Obsidian sync)
app.route('/wiki', createWikiRouter());

// Agent routes protected by bearer token
app.use('/agents/*', async (c, next) => {
	const token = (c.env.LIBRARY_TOKEN ?? c.env.SOCIETY_TOKEN) as string | undefined;
	const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	if (typeof token !== 'string' || token.length === 0 || given !== token) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	await next();
});

if (__QUALIFICATION__) installQualification(app as never);

app.route('/agents/curator', createAgentRouter(Curator));
app.route('/agents/librarian', createAgentRouter(Librarian));
app.route('/agents/steward', createAgentRouter(Steward));
app.route('/agents/sage', createAgentRouter(Sage));
app.route('/agents/alice', createAgentRouter(Alice));
app.route('/agents/bob', createAgentRouter(Bob));

export default app;
