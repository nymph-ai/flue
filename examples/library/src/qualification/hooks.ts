/**
 * The `cloudflare` export every library agent module re-exports. Composes
 * the durable MCP task and event RPC surface (backed by DO SQLite) onto the
 * Curator Durable Object. In a `QUALIFICATION=1` build it also layers the
 * test-only qualification hooks (`agent-hooks.ts`).
 */
import { extend } from '@flue/runtime/cloudflare';
import { mcpBase } from '../mcp/tasks.ts';
import { qualifiedBase, qualifiedWrap } from './agent-hooks.ts';

export const cloudflare = extend({
	base: (Base: any) => {
		const WithMcp = mcpBase(Base);
		return __QUALIFICATION__ ? qualifiedBase(WithMcp) : WithMcp;
	},
	wrap: (__QUALIFICATION__ ? qualifiedWrap : (Final: any) => Final) as never,
});
