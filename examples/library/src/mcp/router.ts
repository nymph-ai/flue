/**
 * Model Context Protocol (MCP) 2.0 (2026-07-28) Server with Native MCP Events.
 * Implements full protocol contract for OpenAI Dots and persistent AI coworkers:
 * - Commands: submit_task, get_task, get_result, cancel_task, search, fetch, acknowledge_result.
 * - Events: events/list, events/subscribe, events/unsubscribe, task_changed notifications.
 * - Atomic durable results with sources, versions, limitations, and signed webhook deliveries.
 * - Stateless edge ingress with delegation to Durable Object SQLite backend.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getOrCreateVault } from '../wiki/routes.ts';
import { LibraryVault } from '../wiki/storage.ts';
import { getOpenApiSpec } from './openapi.ts';
import {
	constantTimeEqual,
	getOrCreateTaskStore,
	signPayload,
	signStandardWebhook,
	TaskStore,
	verifyPayloadSignature,
	verifyStandardWebhook,
} from './tasks.ts';
import type {
	DeliveryRecord,
	SubscriptionRecord,
	TaskChangedEvent,
	TaskRecord,
	TaskResult,
} from './types.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const SERVER_INFO = {
	name: 'library-knowledge-vault',
	version: '2.0.0',
};

export const COMMAND_TOOLS = [
	{
		name: 'submit_task',
		description:
			'Submit an asynchronous job to the knowledge library (e.g. story curation, literature synthesis, topic research). Returns immediately with a durable task ID.',
		inputSchema: {
			type: 'object',
			properties: {
				task_type: {
					type: 'string',
					description:
						'Type of task to execute ("curate" | "synthesize" | "research" | "rebuild_index").',
				},
				payload: {
					type: 'object',
					description:
						'Arguments for the task (e.g. native_id, title, url, summary, concepts, query).',
				},
				correlation_id: {
					type: 'string',
					description:
						'Optional caller-supplied correlation ID (e.g. Dot conversation ID or thread ID).',
				},
			},
			required: ['task_type', 'payload'],
		},
		annotations: { destructiveHint: false },
	},
	{
		name: 'get_task',
		description:
			'Check the status, revision, and summary of a submitted task by its durable task ID.',
		inputSchema: {
			type: 'object',
			properties: {
				task_id: { type: 'string', description: 'The durable task ID returned from submit_task.' },
			},
			required: ['task_id'],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: 'get_result',
		description:
			'Retrieve the completed durable result for a task, including verified sources, model versions, limitations, vault artifacts, and synthesized content.',
		inputSchema: {
			type: 'object',
			properties: {
				task_id: { type: 'string', description: 'The durable task ID.' },
			},
			required: ['task_id'],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: 'cancel_task',
		description: 'Cancel an in-flight or queued task, preventing or aborting further work.',
		inputSchema: {
			type: 'object',
			properties: {
				task_id: { type: 'string', description: 'The durable task ID to cancel.' },
				reason: { type: 'string', description: 'Optional explanation for cancellation.' },
			},
			required: ['task_id'],
		},
		annotations: { destructiveHint: true },
	},
	{
		name: 'search',
		description:
			'Search the Google OKF knowledge vault for technical stories, concepts, or literature.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search term or keyword.' },
				type: {
					type: 'string',
					enum: ['all', 'stories', 'concepts'],
					description: 'Optional filter by note type.',
				},
			},
			required: ['query'],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: 'fetch',
		description:
			'Fetch the raw Google OKF markdown content of any note in the vault (stories/<id>.md, concepts/<slug>.md, index.md).',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Relative path of the note, e.g. "stories/hn-49930412.md".',
				},
			},
			required: ['path'],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: 'acknowledge_result',
		description:
			'Explicitly acknowledge that the client (OpenAI Dot) has read and processed a task result. Distinct from HTTP delivery acknowledgement.',
		inputSchema: {
			type: 'object',
			properties: {
				task_id: { type: 'string', description: 'The task ID whose result is being acknowledged.' },
				receipt: {
					type: 'object',
					description:
						'Optional client processing metadata, e.g. thread_id, processed_at, action_taken.',
				},
			},
			required: ['task_id'],
		},
		annotations: { destructiveHint: false },
	},
];

export const EVENT_DEFINITIONS = [
	{
		name: 'task_changed',
		description:
			'Fired whenever an asynchronous task changes state (queued, running, completed, failed, input_required, cancelled). Delivers state revision, cursor, status, summary, and durable result reference.',
		delivery: ['webhook'],
		inputSchema: {
			type: 'object',
			properties: {
				filter: {
					type: 'object',
					properties: {
						taskId: { type: 'string', description: 'Filter notifications to a specific task ID.' },
						correlationId: {
							type: 'string',
							description: 'Filter notifications to a specific conversation or correlation ID.',
						},
					},
					description: 'Optional filter criteria for events.',
				},
				taskId: { type: 'string', description: 'Filter notifications to a specific task ID.' },
				correlationId: {
					type: 'string',
					description: 'Filter notifications to a specific conversation or correlation ID.',
				},
				cursor: {
					type: 'string',
					description: 'Opaque cursor for event streaming and replay.',
				},
			},
		},
		payloadSchema: {
			type: 'object',
			properties: {
				event: { type: 'string', enum: ['task_changed'] },
				eventId: { type: 'string', description: 'Unique UUID for event deduplication.' },
				taskId: { type: 'string', description: 'Durable task ID.' },
				correlationId: { type: 'string', description: 'Caller-supplied correlation ID.' },
				revision: { type: 'integer', description: 'Monotonically increasing state revision.' },
				cursor: { type: 'string', description: 'Opaque cursor for event streaming and replay.' },
				status: {
					type: 'string',
					enum: ['queued', 'running', 'completed', 'failed', 'input_required', 'cancelled'],
				},
				summary: { type: 'string', description: 'Human-readable summary of the state change.' },
				resultReference: { type: 'string', description: 'URI pointing to the durable result.' },
				error: { type: 'string', description: 'Error message if status is failed.' },
				timestamp: { type: 'string', format: 'date-time', description: 'ISO-8601 timestamp.' },
			},
			required: ['event', 'eventId', 'taskId', 'revision', 'status', 'summary', 'timestamp'],
		},
		schema: {
			type: 'object',
			properties: {
				event: { type: 'string', enum: ['task_changed'] },
				eventId: { type: 'string', description: 'Unique UUID for event deduplication.' },
				taskId: { type: 'string', description: 'Durable task ID.' },
				correlationId: { type: 'string', description: 'Caller-supplied correlation ID.' },
				revision: { type: 'integer', description: 'Monotonically increasing state revision.' },
				cursor: { type: 'string', description: 'Opaque cursor for event streaming and replay.' },
				status: {
					type: 'string',
					enum: ['queued', 'running', 'completed', 'failed', 'input_required', 'cancelled'],
				},
				summary: {
					type: 'string',
					description: 'Short human-readable summary of the state change.',
				},
				resultReference: { type: 'string', description: 'URI pointing to the durable result.' },
				error: { type: 'string', description: 'Error message if status is failed.' },
				timestamp: { type: 'string', format: 'date-time', description: 'ISO-8601 timestamp.' },
			},
			required: ['event', 'eventId', 'taskId', 'revision', 'status', 'summary', 'timestamp'],
		},
	},
];

export interface McpTaskStore {
	submitTask(params: {
		type: string;
		payload: Record<string, unknown>;
		correlationId?: string;
	}): Promise<TaskRecord> | TaskRecord;
	getTask(taskId: string): Promise<TaskRecord | null> | TaskRecord | null;
	getResult(taskId: string): Promise<TaskResult | null> | TaskResult | null;
	cancelTask(taskId: string, reason?: string): Promise<boolean> | boolean;
	acknowledgeResult(taskId: string, receipt?: unknown): Promise<boolean> | boolean;
	subscribe(params: {
		callbackUrl: string;
		secret?: string;
		filter?: { taskId?: string; correlationId?: string };
		fromRevision?: number;
		cursor?: string;
	}):
		| Promise<{
				subscription: SubscriptionRecord;
				replayedEvents: TaskChangedEvent[];
				cursor: string;
		  }>
		| { subscription: SubscriptionRecord; replayedEvents: TaskChangedEvent[]; cursor: string };
	unsubscribe(subscriptionId: string): Promise<boolean> | boolean;
	listEvents(filter?: {
		taskId?: string;
		correlationId?: string;
		fromRevision?: number;
		cursor?: string;
	}): Promise<TaskChangedEvent[]> | TaskChangedEvent[];
	getDeliveryRecords(taskId?: string): Promise<DeliveryRecord[]> | DeliveryRecord[];
	getNote?(path: string): Promise<string | null> | string | null;
	listNotes?(prefix?: string): Promise<string[]> | string[];
}

function rpcSuccess(id: unknown, result: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function toolResult(id: unknown, text: string, isError = false): Response {
	return rpcSuccess(id, {
		content: [{ type: 'text', text }],
		...(isError ? { isError: true } : {}),
	});
}

const testCallbacks: Array<{
	receivedAt: string;
	headers: Record<string, string>;
	payload: unknown;
	signatureValid?: boolean;
}> = [];

export function createMcpRouter(
	getVault: (env?: Record<string, unknown>) => LibraryVault = getOrCreateVault,
	getTaskStore: (vaultFn?: () => LibraryVault) => TaskStore = getOrCreateTaskStore,
) {
	const router = new Hono<{ Bindings: Record<string, unknown> }>();

	router.use(
		'*',
		cors({
			origin: '*',
			allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
			allowHeaders: [
				'Content-Type',
				'Authorization',
				'x-mcp-event-signature',
				'x-mcp-event-id',
				'x-mcp-task-id',
				'x-mcp-revision',
				'x-mcp-cursor',
				'x-mcp-event-type',
			],
			exposeHeaders: [
				'x-mcp-event-signature',
				'x-mcp-event-id',
				'x-mcp-task-id',
				'x-mcp-revision',
				'x-mcp-cursor',
				'x-mcp-event-type',
			],
		}),
	);

	router.options('*', () => new Response(null, { status: 204 }));

	const resolveTaskStore = () => getTaskStore(() => getVault());
	const resolveVault = (env?: Record<string, unknown>) => getVault(env);

	const resolveStore = (env?: Record<string, unknown>): McpTaskStore => {
		const curatorBinding = env?.FLUE_CURATOR_AGENT as { getByName(name: string): any } | undefined;
		if (curatorBinding && typeof curatorBinding.getByName === 'function') {
			const stub = curatorBinding.getByName('curator');
			return {
				submitTask: (params) => stub.submitMcpTask(params),
				getTask: (taskId) => stub.getMcpTask(taskId),
				getResult: (taskId) => stub.getMcpResult(taskId),
				cancelTask: (taskId, reason) => stub.cancelMcpTask(taskId, reason),
				acknowledgeResult: (taskId, receipt) => stub.acknowledgeMcpResult(taskId, receipt),
				subscribe: (params) => stub.subscribeMcp(params),
				unsubscribe: (subId) => stub.unsubscribeMcp(subId),
				listEvents: (filter) => stub.listMcpEvents(filter),
				getDeliveryRecords: (taskId) => stub.getMcpDeliveries(taskId),
				getNote: (path) => stub.getMcpNote(path),
				listNotes: (prefix) => stub.listMcpNotes(prefix),
			};
		}
		return resolveTaskStore();
	};

	// GET /mcp — Discovery and protocol capability negotiation
	router.get('/', (c) =>
		c.json({
			resultType: 'complete',
			name: SERVER_INFO.name,
			version: SERVER_INFO.version,
			protocol: MCP_PROTOCOL_VERSION,
			protocolVersion: MCP_PROTOCOL_VERSION,
			supportedVersions: [MCP_PROTOCOL_VERSION, '2024-11-05'],
			serverInfo: SERVER_INFO,
			_meta: SERVER_INFO,
			capabilities: {
				tools: { listChanged: false },
				events: { subscribe: true, list: true, history: true },
				resources: { subscribe: false, listChanged: false },
				prompts: { listChanged: false },
			},
			tools: COMMAND_TOOLS.map((t) => t.name),
			events: EVENT_DEFINITIONS.map((e) => e.name),
			toolDefinitions: COMMAND_TOOLS,
			eventDefinitions: EVENT_DEFINITIONS,
			endpoints: {
				rpc: '/mcp',
				tasks: '/mcp/tasks',
				results: '/mcp/results',
				events: '/mcp/events',
				deliveries: '/mcp/deliveries',
				testCallback: '/mcp/test-callback',
			},
		}),
	);

	// REST endpoints for direct inspection
	router.get('/tasks/:id', async (c) => {
		const store = resolveStore(c.env);
		const task = await store.getTask(c.req.param('id'));
		if (!task) return c.json({ error: 'not_found', taskId: c.req.param('id') }, 404);
		return c.json(task);
	});

	router.get('/results/:id', async (c) => {
		const store = resolveStore(c.env);
		const result = await store.getResult(c.req.param('id'));
		if (!result) return c.json({ error: 'not_found', taskId: c.req.param('id') }, 404);
		return c.json(result);
	});

	router.get('/events', async (c) => {
		const store = resolveStore(c.env);
		const taskId = c.req.query('taskId');
		const correlationId = c.req.query('correlationId');
		const events = await store.listEvents({ taskId, correlationId });
		return c.json({ total: events.length, events });
	});

	router.get('/deliveries/:taskId', async (c) => {
		const store = resolveStore(c.env);
		const deliveries = await store.getDeliveryRecords(c.req.param('taskId'));
		return c.json({ total: deliveries.length, deliveries });
	});

	router.get('/openapi.json', (c) => {
		const origin = new URL(c.req.url).origin;
		return c.json(getOpenApiSpec(origin));
	});

	router.post('/test-callback', async (c) => {
		const secret = c.req.query('secret');
		const sigHeader = c.req.header('x-mcp-event-signature');
		const rawText = await c.req.text();
		let payload: unknown = null;
		try {
			payload = JSON.parse(rawText);
		} catch {
			payload = rawText;
		}

		let signatureValid: boolean | undefined = undefined;
		if (secret) {
			if (sigHeader) {
				signatureValid = await verifyPayloadSignature(secret, rawText, sigHeader);
			} else {
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

		const record = {
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
	});

	router.get('/test-callback', (c) => {
		return c.json({
			total: testCallbacks.length,
			callbacks: testCallbacks,
		});
	});

	router.delete('/test-callback', (c) => {
		testCallbacks.length = 0;
		return c.json({ cleared: true });
	});

	// POST /mcp — Unified JSON-RPC 2.0 Handler
	router.post('/', async (c) => {
		let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
		try {
			body = (await c.req.json()) ?? {};
		} catch {
			return rpcError(null, -32700, 'Parse error: invalid JSON');
		}

		const id = body.id ?? null;
		const method = body.method;
		const taskStore = resolveStore(c.env);
		const vault = resolveVault(c.env);

		// 0. server/discover (Stateless discovery mandatory in MCP 2026-07-28)
		if (
			method === 'server/discover' ||
			method === 'discover' ||
			method === 'server/info' ||
			method === 'server/capabilities'
		) {
			return rpcSuccess(id, {
				resultType: 'complete',
				protocolVersion: MCP_PROTOCOL_VERSION,
				supportedVersions: [MCP_PROTOCOL_VERSION, '2024-11-05'],
				serverInfo: SERVER_INFO,
				_meta: SERVER_INFO,
				capabilities: {
					tools: { listChanged: false },
					events: { subscribe: true, list: true, history: true },
					resources: { subscribe: false, listChanged: false },
					prompts: { listChanged: false },
				},
				instructions:
					'Autonomous Knowledge Vault with MCP Events for OpenAI Dots. Submit tasks asynchronously, subscribe to task_changed events, and retrieve verified durable results.',
				tools: COMMAND_TOOLS,
				events: EVENT_DEFINITIONS,
			});
		}

		// 1. initialize
		if (method === 'initialize') {
			const reqVersion =
				typeof body.params?.protocolVersion === 'string'
					? body.params.protocolVersion
					: MCP_PROTOCOL_VERSION;
			return rpcSuccess(id, {
				protocolVersion: reqVersion,
				supportedVersions: [MCP_PROTOCOL_VERSION, '2024-11-05'],
				capabilities: {
					tools: { listChanged: false },
					events: { subscribe: true, list: true, history: true },
					resources: { subscribe: false, listChanged: false },
					prompts: { listChanged: false },
				},
				serverInfo: SERVER_INFO,
				_meta: SERVER_INFO,
				instructions:
					'Autonomous Knowledge Vault with MCP Events for OpenAI Dots. Submit tasks asynchronously, subscribe to task_changed events, and retrieve verified durable results.',
			});
		}

		// 2. notifications/initialized
		if (method === 'notifications/initialized') {
			return new Response(null, { status: 204 });
		}

		// 3. ping
		if (method === 'ping') {
			return rpcSuccess(id, {});
		}

		// resources/list
		if (method === 'resources/list') {
			return rpcSuccess(id, { resources: [] });
		}

		// prompts/list
		if (method === 'prompts/list') {
			return rpcSuccess(id, { prompts: [] });
		}

		// 4. tools/list
		if (method === 'tools/list') {
			return rpcSuccess(id, { tools: COMMAND_TOOLS });
		}

		// 5. events/list
		if (method === 'events/list') {
			return rpcSuccess(id, { events: EVENT_DEFINITIONS });
		}

		// 6. events/subscribe
		if (method === 'events/subscribe') {
			const params = body.params ?? {};
			console.log(`[mcp:events/subscribe] Incoming params: ${JSON.stringify(params)}`);
			const delivery = (params.delivery ?? {}) as Record<string, unknown>;
			const callbackUrl = String(
				delivery.url ?? delivery.callbackUrl ?? params.callbackUrl ?? params.callback_url ?? '',
			);
			if (!callbackUrl) {
				return rpcError(
					id,
					-32602,
					'events/subscribe requires a delivery.url or callbackUrl parameter',
				);
			}
			const secret = delivery.secret
				? String(delivery.secret)
				: params.secret
					? String(params.secret)
					: undefined;

			const args = (params.arguments ?? params.filter ?? {}) as Record<string, unknown>;
			const taskId = args.taskId
				? String(args.taskId)
				: args.task_id
					? String(args.task_id)
					: params.taskId
						? String(params.taskId)
						: undefined;
			const correlationId = args.correlationId
				? String(args.correlationId)
				: args.correlation_id
					? String(args.correlation_id)
					: params.correlationId
						? String(params.correlationId)
						: undefined;
			const filter = taskId || correlationId ? { taskId, correlationId } : undefined;

			const rawCursor = params.cursor ?? params.fromRevision ?? args.cursor;
			let fromRevision: number | undefined = undefined;
			if (typeof rawCursor === 'number') {
				fromRevision = rawCursor;
			} else if (typeof rawCursor === 'string' && rawCursor.trim() !== '') {
				const parsed = parseInt(rawCursor, 10);
				if (!Number.isNaN(parsed)) {
					fromRevision = parsed;
				}
			}

			const cursorParam =
				typeof rawCursor === 'string'
					? rawCursor
					: typeof rawCursor === 'number'
						? String(rawCursor)
						: undefined;

			// If secret is present, perform the standard callback verification challenge
			if (secret && !params.skipVerification) {
				const challenge = `chg_${crypto.randomUUID().replace(/-/g, '')}`;
				const challengePayload = JSON.stringify({
					type: 'verification',
					challenge,
				});
				const chgId = `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
				const chgTimestamp = Math.floor(Date.now() / 1000).toString();

				const chgHeaders: Record<string, string> = {
					'content-type': 'application/json',
					'webhook-id': chgId,
					'webhook-timestamp': chgTimestamp,
					'x-mcp-event-id': chgId,
					'x-mcp-event-type': 'verification',
				};

				try {
					chgHeaders['webhook-signature'] = await signStandardWebhook(
						secret,
						chgId,
						chgTimestamp,
						challengePayload,
					);
					chgHeaders['x-mcp-event-signature'] = await signPayload(secret, challengePayload);
				} catch (signErr) {
					console.error('[mcp:events/subscribe] Failed to sign verification challenge:', signErr);
				}

				try {
					console.log(
						`[mcp:events/subscribe] Dispatching verification challenge to: ${callbackUrl}`,
					);
					let chgRes: Response;
					if (
						callbackUrl.includes('library.nymphai.workers.dev') ||
						callbackUrl.startsWith('http://localhost')
					) {
						chgRes = await router.fetch(
							new Request(callbackUrl, {
								method: 'POST',
								headers: chgHeaders,
								body: challengePayload,
							}),
						);
					} else {
						chgRes = await fetch(callbackUrl, {
							method: 'POST',
							headers: chgHeaders,
							body: challengePayload,
						});
					}

					const chgText = await chgRes.text();
					console.log(
						`[mcp:events/subscribe] Challenge response HTTP ${chgRes.status}: body=${chgText}`,
					);

					if (!chgRes.ok) {
						return rpcError(
							id,
							-32015,
							`Callback verification failed: endpoint returned HTTP ${chgRes.status}`,
							{ reason: 'challenge_failed', status: chgRes.status, body: chgText },
						);
					}

					let echoed = chgText.trim();
					try {
						const json = JSON.parse(chgText);
						if (json && typeof json.challenge === 'string') {
							echoed = json.challenge.trim();
						}
					} catch {
						// continue
					}

					if (!constantTimeEqual(echoed, challenge)) {
						console.warn(
							`[mcp:events/subscribe] Challenge echo mismatch: expected=${challenge}, got=${echoed}`,
						);
						return rpcError(id, -32015, 'Callback verification failed: challenge_failed', {
							reason: 'challenge_failed',
							expected: challenge,
							received: echoed,
						});
					}
					console.log('[mcp:events/subscribe] Callback verification succeeded');
				} catch (fetchErr) {
					console.error(
						`[mcp:events/subscribe] Network error during callback verification for ${callbackUrl}:`,
						fetchErr,
					);
					return rpcError(
						id,
						-32015,
						`Callback verification failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
						{ reason: 'challenge_failed' },
					);
				}
			}

			const { subscription, replayedEvents, cursor } = await taskStore.subscribe({
				callbackUrl,
				secret,
				filter,
				fromRevision,
				cursor: cursorParam,
			});

			return rpcSuccess(id, {
				subscriptionId: subscription.id,
				id: subscription.id,
				refreshBefore: new Date(Date.now() + 7 * 86400000).toISOString(),
				cursor,
				delivery: {
					type: 'webhook',
					mode: 'webhook',
					url: subscription.callbackUrl,
				},
				callbackUrl: subscription.callbackUrl,
				replayedEventsCount: replayedEvents.length,
				filter: subscription.filter,
			});
		}

		// 7. events/unsubscribe
		if (method === 'events/unsubscribe') {
			const params = body.params ?? {};
			const subId = String(params.subscriptionId ?? params.subscription_id ?? params.id ?? '');
			const ok = await taskStore.unsubscribe(subId);
			return rpcSuccess(id, { success: ok, subscriptionId: subId });
		}

		// 8. tools/call
		if (method === 'tools/call') {
			const params = body.params ?? {};
			const toolName = String(params.name ?? '');
			const args = (params.arguments ?? {}) as Record<string, unknown>;

			switch (toolName) {
				case 'submit_task': {
					const taskType = String(args.task_type ?? args.type ?? '');
					const payload = (args.payload ?? {}) as Record<string, unknown>;
					const correlationId = args.correlation_id ? String(args.correlation_id) : undefined;

					if (!taskType) return toolResult(id, 'submit_task requires task_type', true);

					const task = await taskStore.submitTask({
						type: taskType,
						payload,
						correlationId,
					});

					return toolResult(
						id,
						JSON.stringify(
							{
								taskId: task.id,
								correlationId: task.correlationId,
								status: task.status,
								revision: task.revision,
								createdAt: task.createdAt,
								resultReference: `/mcp/results/${task.id}`,
							},
							null,
							2,
						),
					);
				}

				case 'get_task': {
					const taskId = String(args.task_id ?? '');
					if (!taskId) return toolResult(id, 'get_task requires task_id', true);
					const task = await taskStore.getTask(taskId);
					if (!task) return toolResult(id, `Task not found: ${taskId}`, true);
					return toolResult(id, JSON.stringify(task, null, 2));
				}

				case 'get_result': {
					const taskId = String(args.task_id ?? '');
					if (!taskId) return toolResult(id, 'get_result requires task_id', true);
					const result = await taskStore.getResult(taskId);
					if (!result) {
						const task = await taskStore.getTask(taskId);
						if (!task) return toolResult(id, `Task not found: ${taskId}`, true);
						return toolResult(
							id,
							`Task ${taskId} is currently ${task.status}; result not yet ready.`,
							true,
						);
					}
					return toolResult(id, JSON.stringify(result, null, 2));
				}

				case 'cancel_task': {
					const taskId = String(args.task_id ?? '');
					const reason = args.reason ? String(args.reason) : undefined;
					if (!taskId) return toolResult(id, 'cancel_task requires task_id', true);
					const ok = await taskStore.cancelTask(taskId, reason);
					return toolResult(id, JSON.stringify({ taskId, cancelled: ok }));
				}

				case 'acknowledge_result': {
					const taskId = String(args.task_id ?? '');
					const receipt = args.receipt;
					if (!taskId) return toolResult(id, 'acknowledge_result requires task_id', true);
					const ok = await taskStore.acknowledgeResult(taskId, receipt);
					return toolResult(id, JSON.stringify({ taskId, acknowledged: ok }));
				}

				case 'search': {
					const query = String(args.query ?? '').toLowerCase();
					if (!query) return toolResult(id, 'search requires query', true);
					const vaultPaths = await vault.listNotes();
					const storePaths = taskStore.listNotes ? await taskStore.listNotes() : [];
					const allPaths = Array.from(new Set([...vaultPaths, ...storePaths]));
					const targetType = args.type ? String(args.type) : 'all';

					const targetPaths = allPaths.filter((p) => {
						if (targetType === 'stories') return p.startsWith('stories/');
						if (targetType === 'concepts') return p.startsWith('concepts/');
						return true;
					});

					const matches: Array<{ path: string; excerpt: string }> = [];
					for (const p of targetPaths) {
						let content = await vault.getNote(p);
						if ((content === null || content === undefined) && taskStore.getNote) {
							content = await taskStore.getNote(p);
						}
						if (content && content.toLowerCase().includes(query)) {
							const idx = content.toLowerCase().indexOf(query);
							const start = Math.max(0, idx - 60);
							const end = Math.min(content.length, idx + 100);
							matches.push({
								path: p,
								excerpt: `...${content.slice(start, end).replace(/\n+/g, ' ')}...`,
							});
						}
					}
					return toolResult(
						id,
						JSON.stringify(
							{ query, totalMatches: matches.length, matches: matches.slice(0, 10) },
							null,
							2,
						),
					);
				}

				case 'fetch': {
					let path = String(args.path ?? '').trim();
					if (!path) return toolResult(id, 'fetch requires path', true);
					if (!path.endsWith('.md')) path = `${path}.md`;
					const cleanPath = path.replace(/^\/+/, '');
					let content = await vault.getNote(cleanPath);
					if ((content === null || content === undefined) && taskStore.getNote) {
						content = await taskStore.getNote(cleanPath);
					}
					if (content === null || content === undefined) {
						return toolResult(id, `Note not found: ${path}`, true);
					}
					return toolResult(id, content);
				}

				default:
					return rpcError(id, -32601, `Method not found: tool ${toolName}`);
			}
		}

		return rpcError(id, -32601, `Method not found: ${method}`);
	});

	return router;
}
