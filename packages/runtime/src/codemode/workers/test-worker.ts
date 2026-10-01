/**
 * The Worker the Code Mode tests run in (vitest.workers.config.ts): an agent
 * stand-in Durable Object whose isolate runs the scripts. Importing
 * `cloudflare/codemode.ts` registers the compiled QuickJS module, as the
 * generated Worker entry does.
 */
import { DurableObject } from 'cloudflare:workers';
import '../../cloudflare/codemode.ts';

// Flue's Durable Object storage adapters (src/cloudflare/workers/do-sqlite.workers.test.ts).
export { SqliteProbe } from '../../cloudflare/workers/probe.ts';
// A new entity's first wake, row by row (src/cloudflare/workers/first-wake.workers.test.ts).
export { FirstWakeAgent, RowsAgent } from '../../cloudflare/workers/first-wake.ts';
// A Code Mode turn over an MCP server, row by row (src/cloudflare/workers/codemode-rows.workers.test.ts).
export { CodemodeTurnAgent } from '../../cloudflare/workers/codemode-turn.ts';

export class CodemodeTestAgent extends DurableObject {}

export default {
	fetch: () => new Response('codemode tests'),
};
