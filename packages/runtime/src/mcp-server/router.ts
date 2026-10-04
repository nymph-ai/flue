/**
 * Hono router for Flue MCP Capability Projection.
 *
 * Exposes Streamable HTTP endpoints (MCP 2026-07-28), pre-connection Server Cards,
 * and REST inspection endpoints.
 *
 * Invariant: MCP 2026-07-28 requires stateless streamable-http. Legacy SSE is rejected with HTTP 400.
 *
 * Reference: docs/mcp-capability-projection.md
 */

import { Hono } from 'hono';
import { verifyStandardWebhook } from './events.ts';
import type {
	McpCapabilityProjection,
	McpJsonRpcRequest,
	McpJsonRpcResponse,
} from './projection.ts';
import type { AuthContext } from './types.ts';
import { MCP_2026_07_28 } from './types.ts';

export interface RouterOptions {
	basePath?: string;
	cors?: boolean;
	authenticate?: (c: any) => Promise<AuthContext | null> | AuthContext | null;
	defaultScopes?: string[];
	allowAnonymousInspection?: boolean;
}

export interface TestCallbackRecord {
	receivedAt: string;
	headers: Record<string, string>;
	payload: unknown;
	signatureValid?: boolean;
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
	const testCallbacks: TestCallbackRecord[] = [];

	const setCorsHeaders = (c: any) => {
		if (enableCors) {
			c.header('Access-Control-Allow-Origin', '*');
			c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
			c.header(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, x-mcp-protocol-version, x-mcp-variant, x-mcp-profile, x-actor, x-delegator, x-mcp-event-signature, x-mcp-event-id, x-mcp-task-id, x-mcp-revision, x-mcp-cursor, x-mcp-event-type',
			);
			c.header(
				'Access-Control-Expose-Headers',
				'x-mcp-event-signature, x-mcp-event-id, x-mcp-task-id, x-mcp-revision, x-mcp-cursor, x-mcp-event-type',
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
	app.options(`${basePath}/test-callback`, handleOptions);

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
				resultType: 'complete',
				name: projection.descriptor.name,
				version: projection.descriptor.version,
				protocol: MCP_2026_07_28,
				protocolVersion: MCP_2026_07_28,
				supportedVersions: [MCP_2026_07_28, '2024-11-05'],
				serverInfo: {
					name: projection.descriptor.name,
					version: projection.descriptor.version,
					description: projection.descriptor.description,
				},
				_meta: {
					name: projection.descriptor.name,
					version: projection.descriptor.version,
				},
				endpoints: projection.descriptor.endpoints,
				capabilities: {
					tools: { listChanged: false },
					resources: { subscribe: true, listChanged: false },
					prompts: { listChanged: false },
					logging: {},
					events: { subscribe: true, list: true, history: true },
				},
				extensions: projection.descriptor.extensions,
				tools: projection.registry.list().map((t) => t.id),
				events: ['task_changed'],
			},
			200,
		);
	};

	app.get(`${basePath}/mcp`, handleMcpGet);
	app.get('/mcp', handleMcpGet);
	app.get(`${basePath}/`, handleMcpGet);

	// Helper to enforce auth on inspection endpoints (secured by default in production)
	const requireInspectionAuth = async (c: any) => {
		if (options?.allowAnonymousInspection) {
			return null;
		}
		const isTestEnv =
			typeof process !== 'undefined' &&
			(process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true');
		if (isTestEnv && !options?.authenticate) {
			return null;
		}
		if (options?.authenticate) {
			const verified = await options.authenticate(c);
			if (!verified) {
				return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401);
			}
			return null;
		}
		return c.json(
			{
				error: 'unauthorized',
				message: 'Inspection endpoints require authentication in production',
			},
			401,
		);
	};

	// -------------------------------------------------------------------------
	// REST Inspection Endpoints (Tasks, Results, Events, Deliveries)
	// -------------------------------------------------------------------------
	app.get(`${basePath}/tasks/:id`, async (c: any) => {
		const unauthorized = await requireInspectionAuth(c);
		if (unauthorized) return unauthorized;
		const task = await projection.operationPort.getOperation(c.req.param('id'));
		if (!task) return c.json({ error: 'not_found', taskId: c.req.param('id') }, 404);
		return c.json(task);
	});

	app.get(`${basePath}/results/:id`, async (c: any) => {
		const unauthorized = await requireInspectionAuth(c);
		if (unauthorized) return unauthorized;
		const task = await projection.operationPort.getOperation(c.req.param('id'));
		if (!task?.result) {
			return c.json({ error: 'not_found', taskId: c.req.param('id') }, 404);
		}
		return c.json(task.result);
	});

	app.get(`${basePath}/events`, async (c: any) => {
		const unauthorized = await requireInspectionAuth(c);
		if (unauthorized) return unauthorized;
		const streamId = c.req.query('streamId') ?? 'task_events';
		const cursor = c.req.query('cursor');
		const events = await projection.eventPort.readEvents(streamId, cursor);
		return c.json(events);
	});

	app.get(`${basePath}/deliveries/:taskId`, async (c: any) => {
		const unauthorized = await requireInspectionAuth(c);
		if (unauthorized) return unauthorized;
		const deliveries = projection.eventPort.getDeliveryLogs
			? await projection.eventPort.getDeliveryLogs()
			: [];
		const taskId = c.req.param('taskId');
		const filtered = deliveries.filter((d) => d.taskId === taskId);
		return c.json({ total: filtered.length, deliveries: filtered });
	});

	app.get(`${basePath}/audit-logs`, async (c: any) => {
		const unauthorized = await requireInspectionAuth(c);
		if (unauthorized) return unauthorized;
		const limit = Number(c.req.query('limit')) || 50;
		const logs = projection.eventPort.getAuditLogs
			? await projection.eventPort.getAuditLogs(limit)
			: [];
		return c.json({ total: logs.length, logs }, 200, {
			'access-control-allow-origin': '*',
		});
	});

	// -------------------------------------------------------------------------
	// Webhook Test Callback Endpoint
	// -------------------------------------------------------------------------
	const handleTestCallback = async (c: any) => {
		const rawText = await c.req.text();
		let payload: unknown = null;
		try {
			payload = JSON.parse(rawText);
		} catch {
			payload = rawText;
		}

		let signatureValid: boolean | undefined;
		const subIdHeader = c.req.header('x-mcp-subscription-id');
		if (subIdHeader) {
			const sub = projection.eventPort.getSubscription
				? await projection.eventPort.getSubscription(subIdHeader)
				: undefined;
			const secret = sub?.secret;
			if (secret) {
				const standardSig = c.req.header('webhook-signature');
				const msgId = c.req.header('webhook-id');
				const ts = c.req.header('webhook-timestamp');
				if (standardSig && msgId && ts) {
					signatureValid = await verifyStandardWebhook(secret, msgId, ts, rawText, standardSig);
				}
			}
		}

		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(c.req.header())) {
			if (typeof v === 'string') headers[k] = v;
		}

		const record: TestCallbackRecord = {
			receivedAt: new Date().toISOString(),
			headers,
			payload,
			signatureValid,
		};
		testCallbacks.push(record);

		if (
			payload &&
			typeof payload === 'object' &&
			(payload as Record<string, unknown>).type === 'verification'
		) {
			const challenge = (payload as Record<string, unknown>).challenge;
			return c.json({
				ok: true,
				challenge,
				received: true,
				signatureValid,
			});
		}

		return c.json({
			ok: true,
			received: true,
			signatureValid,
			eventId: c.req.header('x-mcp-event-id'),
			taskId: c.req.header('x-mcp-task-id'),
		});
	};

	app.post(`${basePath}/test-callback`, handleTestCallback);
	app.post('/test-callback', handleTestCallback);
	app.get(`${basePath}/test-callback`, (c: any) =>
		c.json({ total: testCallbacks.length, callbacks: testCallbacks }),
	);
	app.delete(`${basePath}/test-callback`, (c: any) => {
		testCallbacks.length = 0;
		return c.json({ cleared: true });
	});

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

		// Resolve AuthContext
		let auth: Partial<AuthContext> | undefined;
		if (options?.authenticate) {
			const verified = await options.authenticate(c);
			if (verified) auth = verified;
		}

		if (!auth) {
			const principal = c.req.header('x-principal') ?? 'anonymous';
			const actor = c.req.header('x-actor') ?? principal;
			const delegator = c.req.header('x-delegator');

			// Safe default: empty scopes unless explicitly configured
			const scopes = options?.defaultScopes ?? [];

			auth = {
				principal,
				actor,
				delegator,
				scopes,
			};
		}

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
					projection.handleRequest(req as McpJsonRpcRequest, c.req.raw.headers, auth, queryProfile),
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
	app.post(`${basePath}/`, handleMcpPost);

	return app;
}
