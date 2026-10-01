/**
 * The Worker the Code Mode tests run in (vitest.workers.config.ts): an agent
 * stand-in Durable Object to host the runtime facet, and `CodemodeRuntime`
 * exported so `ctx.exports` carries the facet class. Importing
 * `cloudflare/codemode.ts` registers the Code Mode host, as the generated
 * Worker entry does.
 */
import { DurableObject } from 'cloudflare:workers';

export { CodemodeRuntime } from '../../cloudflare/codemode.ts';

export class CodemodeTestAgent extends DurableObject {}

export default {
	fetch: () => new Response('codemode tests'),
};
