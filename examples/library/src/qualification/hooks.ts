/**
 * The `cloudflare` export every library agent module re-exports. In a
 * `QUALIFICATION=1` build it adds the test-only Durable Object hooks
 * (`agent-hooks.ts`); in any other build it is an empty extension and the
 * hooks are not in the bundle.
 */
import { extend } from '@flue/runtime/cloudflare';
import { qualifiedBase, qualifiedWrap } from './agent-hooks.ts';

export const cloudflare = __QUALIFICATION__
	? extend({ base: qualifiedBase as never, wrap: qualifiedWrap as never })
	: extend({});
