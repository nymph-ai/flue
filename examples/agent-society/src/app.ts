/**
 * The agent society: three `'use agent'` agents on Pi Durable, every instance
 * an addressable entity whose history lives on Electric (the `FLUE_STREAMS*`
 * vars and the `FLUE_STREAMS` Workers VPC binding; see wrangler.jsonc).
 *
 * The agent routes are behind the `SOCIETY_TOKEN` bearer secret, since a
 * deployment may run a billed model. Entity wakes (`/__flue/streams/wake`)
 * are served by Flue before this app and verified by their signature.
 */
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Alice } from './agents/alice.ts';
import { Bob } from './agents/bob.ts';
import { Curator } from './agents/curator.ts';
import { societyModel } from './model.ts';
import { installQualification } from './qualification/install.ts';

const app = new Hono<{ Bindings: Record<string, unknown> }>();

app.get('/', (c) =>
	c.json({ society: ['alice', 'bob', 'curator'], model: societyModel(), streams: Boolean(c.env.FLUE_STREAMS_URL) }),
);

app.use('/agents/*', async (c, next) => {
	const token = c.env.SOCIETY_TOKEN;
	const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
	if (typeof token !== 'string' || token.length === 0 || given !== token) {
		return c.json({ error: 'unauthorized' }, 401);
	}
	await next();
});

if (__QUALIFICATION__) installQualification(app as never);

app.route('/agents/alice', createAgentRouter(Alice));
app.route('/agents/bob', createAgentRouter(Bob));
app.route('/agents/curator', createAgentRouter(Curator));

export default app;
