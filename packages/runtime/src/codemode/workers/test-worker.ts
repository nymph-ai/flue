/**
 * The Worker the Code Mode tests run in (vitest.workers.config.ts): an agent
 * stand-in Durable Object to host the runtime facet, and `CodemodeRuntime`
 * exported so `ctx.exports` carries the facet class. Importing
 * `cloudflare/codemode.ts` registers the Code Mode host, as the generated
 * Worker entry does.
 */
import { DurableObject } from 'cloudflare:workers';

export { CodemodeRuntime } from '../../cloudflare/codemode.ts';
// Flue's Durable Object storage adapters (src/cloudflare/workers/do-sqlite.workers.test.ts).
export { SqliteProbe } from '../../cloudflare/workers/probe.ts';
// A new entity's first wake, row by row (src/cloudflare/workers/first-wake.workers.test.ts).
export { FirstWakeAgent, RowsAgent } from '../../cloudflare/workers/first-wake.ts';

export class CodemodeTestAgent extends DurableObject {}

export default {
	fetch: () => new Response('codemode tests'),
};
