/**
 * Hono router for Flue MCP Capability Projection.
 *
 * Exposes Streamable HTTP endpoints (MCP 2026-07-28), pre-connection Server Cards,
 * and preflight CORS handlers.
 *
 * Invariant: MCP 2026-07-28 requires stateless streamable-http. Legacy SSE is rejected with HTTP 400.
 *
 * Reference: docs/mcp-capability-projection.md
 */

import { Hono } from 'hono';
import type { McpCapabilityProjection, McpJsonRpcRequest, McpJsonRpcResponse } from './projection.ts';
import type { AuthContext } from './types.ts';
import { MCP_2026_07_28 } from './types.ts';

export interface RouterOptions {
	basePath?: string;
	cors?: boolean;
}

/**
 * Create a Hono router bound to an McpCapabilityProjection instance.
 */
export function createMcpCapabilityRouter(
	projection: McpCapabilityProjection,
	options?: RouterOptions,
): Hono {
	const app = new Hono();
	const basePath = options?.basePath ?? '';
	const enableCors = options?.cors ?? true;

	const setCorsHeaders = (c: any) => {
		if (enableCors) {
			c.header('Access-Control-Allow-Origin', '*');
			c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			c.header(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, x-mcp-protocol-version, x-mcp-variant, x-mcp-profile, x-actor, x-delegator',
			);
		}
	};

	// -------------------------------------------------------------------------
	// Pre-connection Server Card endpoints (§ 11)
	// -------------------------------------------------------------------------
	const handleServerCard = (c: any) => {
		setCorsHeaders(c);
		const card = projection.serverCardManager.getServerCard();
		return c.json(card, 200, {
			'content-type': 'application/json; charset=utf-8',
		});
	};

	app.get('/.well-known/mcp/server-card.json', handleServerCard);
	app.get('/server-card', handleServerCard);
	if (basePath) {
		app.get(`${basePath}/server-card`, handleServerCard);
	}

	// -------------------------------------------------------------------------
	// CORS Preflight
	// -------------------------------------------------------------------------
	const handleOptions = (c: any) => {
		setCorsHeaders(c);
		return c.body(null, 204);
	};

	app.options('*', handleOptions);
	app.options(`${basePath}/mcp`, handleOptions);

	// -------------------------------------------------------------------------
	// GET /mcp — Protocol check and legacy SSE rejection
	// -------------------------------------------------------------------------
	const handleMcpGet = (c: any) => {
		setCorsHeaders(c);
		const acceptHeader = c.req.header('accept') ?? '';

		// Invariant: Legacy SSE is rejected; MCP 2026-07-28 is strictly stateless Streamable HTTP
		if (acceptHeader.includes('text/event-stream')) {
			return c.json(
				{
					error: 'SSE is deprecated and unsupported; use Streamable HTTP POST/GET.',
					protocolVersion: MCP_2026_07_28,
				},
				400,
			);
		}

		return c.json(
			{
				name: projection.descriptor.name,
				version: projection.descriptor.version,
				protocolVersion: MCP_2026_07_28,
				endpoints: projection.descriptor.endpoints,
				capabilities: projection.descriptor.capabilities,
				extensions: projection.descriptor.extensions,
			},
			200,
		);
	};

	app.get(`${basePath}/mcp`, handleMcpGet);
	app.get('/mcp', handleMcpGet);

	// -------------------------------------------------------------------------
	// POST /mcp — Streamable HTTP JSON-RPC 2.0 Dispatch
	// -------------------------------------------------------------------------
	const handleMcpPost = async (c: any) => {
		setCorsHeaders(c);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json(
				{
					jsonrpc: '2.0',
					id: null,
					error: { code: -32700, message: 'Parse error: invalid JSON' },
				},
				400,
			);
		}

		// Extract auth from headers
		const authHeader = c.req.header('authorization');
		const principal = authHeader
			? authHeader.replace(/^Bearer\s+/i, '')
			: (c.req.header('x-principal') ?? 'anonymous');
		const actor = c.req.header('x-actor') ?? principal;
		const delegator = c.req.header('x-delegator');

		const auth: Partial<AuthContext> = {
			principal,
			actor,
			delegator,
			scopes: ['*'],
		};

		// Extract profile / variant from query or header
		const queryProfile =
			c.req.query('profile') ??
			c.req.query('variant') ??
			c.req.header('x-mcp-profile') ??
			c.req.header('x-mcp-variant');

		// Handle batch or single request
		if (Array.isArray(body)) {
			const responses = await Promise.all(
				body.map((req) =>
					projection.handleRequest(
						req as McpJsonRpcRequest,
						c.req.raw.headers,
						auth,
						queryProfile,
					),
				),
			);
			return c.json(responses, 200);
		}

		const response: McpJsonRpcResponse = await projection.handleRequest(
			body as McpJsonRpcRequest,
			c.req.raw.headers,
			auth,
			queryProfile,
		);

		return c.json(response, 200);
	};

	app.post(`${basePath}/mcp`, handleMcpPost);
	app.post('/mcp', handleMcpPost);

	return app;
}
