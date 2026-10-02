/**
 * OpenAPI 3.1.0 Specification for Autonomous Knowledge Vault.
 * Exposes MCP JSON-RPC 2.0 endpoint, REST inspection endpoints, and tool schemas
 * for OpenAI Dots, ChatGPT Custom Actions, and MCP 2.0 clients.
 */
export function getOpenApiSpec(origin = 'https://library.nymphai.workers.dev') {
	return {
		openapi: '3.1.0',
		info: {
			title: 'Autonomous Knowledge Vault',
			description:
				'Curator and technical knowledge vault in Google Open Knowledge Format (OKF) with MCP 2.0 (2026-07-28) and native MCP Events. Supports asynchronous long-running task submission (curation, literature synthesis, topic research), durable task storage in Cloudflare DO SQLite, signed HMAC webhook callback wake-ups, and verified OKF note retrieval.',
			version: '2.0.0',
			contact: {
				name: 'NymphAI Team',
				email: 'nympharum@proton.me',
			},
		},
		servers: [
			{
				url: origin,
				description: 'Knowledge Vault Edge Endpoint',
			},
		],
		paths: {
			'/mcp': {
				post: {
					operationId: 'mcpRpc',
					summary: 'MCP 2.0 JSON-RPC 2.0 endpoint',
					description:
						'Handles all standard MCP 2.0 methods: initialize, ping, tools/list, tools/call, events/list, events/subscribe, events/unsubscribe.',
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										jsonrpc: { type: 'string', enum: ['2.0'] },
										id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
										method: { type: 'string' },
										params: { type: 'object' },
									},
									required: ['jsonrpc', 'id', 'method'],
								},
							},
						},
					},
					responses: {
						'200': {
							description: 'JSON-RPC response',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											jsonrpc: { type: 'string' },
											id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
											result: { type: 'object' },
											error: { type: 'object' },
										},
									},
								},
							},
						},
					},
				},
				get: {
					operationId: 'mcpDiscovery',
					summary: 'MCP 2.0 Protocol Discovery',
					description: 'Returns server info, capabilities, tools list, and event definitions.',
					responses: {
						'200': {
							description: 'Protocol discovery metadata',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											name: { type: 'string' },
											version: { type: 'string' },
											protocol: { type: 'string' },
											capabilities: { type: 'object' },
											tools: { type: 'array', items: { type: 'string' } },
											events: { type: 'array', items: { type: 'string' } },
											endpoints: { type: 'object' },
										},
									},
								},
							},
						},
					},
				},
			},
			'/mcp/tasks/{id}': {
				get: {
					operationId: 'getTaskStatus',
					summary: 'Get durable task status and revision',
					parameters: [
						{
							name: 'id',
							in: 'path',
							required: true,
							description: 'Durable task ID',
							schema: { type: 'string' },
						},
					],
					responses: {
						'200': {
							description: 'Task record',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											id: { type: 'string' },
											correlationId: { type: 'string' },
											type: { type: 'string' },
											status: { type: 'string' },
											revision: { type: 'integer' },
											summary: { type: 'string' },
											resultReference: { type: 'string' },
											createdAt: { type: 'string' },
											updatedAt: { type: 'string' },
										},
									},
								},
							},
						},
						'404': { description: 'Task not found' },
					},
				},
			},
			'/mcp/results/{id}': {
				get: {
					operationId: 'getTaskResult',
					summary: 'Get completed durable task result',
					parameters: [
						{
							name: 'id',
							in: 'path',
							required: true,
							description: 'Durable task ID',
							schema: { type: 'string' },
						},
					],
					responses: {
						'200': {
							description:
								'Task durable result with verified sources, versions, limitations, and artifacts',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											taskId: { type: 'string' },
											resultId: { type: 'string' },
											status: { type: 'string' },
											summary: { type: 'string' },
											sources: { type: 'array' },
											versions: { type: 'object' },
											limitations: { type: 'array', items: { type: 'string' } },
											artifacts: { type: 'array', items: { type: 'string' } },
											content: { type: 'string' },
											acknowledged: { type: 'boolean' },
											completedAt: { type: 'string' },
										},
									},
								},
							},
						},
						'404': { description: 'Result not ready or not found' },
					},
				},
			},
			'/mcp/events': {
				get: {
					operationId: 'listMcpEvents',
					summary: 'Query historical task events',
					parameters: [
						{ name: 'taskId', in: 'query', required: false, schema: { type: 'string' } },
						{ name: 'correlationId', in: 'query', required: false, schema: { type: 'string' } },
					],
					responses: {
						'200': {
							description: 'Historical events',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											total: { type: 'integer' },
											events: { type: 'array' },
										},
									},
								},
							},
						},
					},
				},
			},
			'/mcp/deliveries/{taskId}': {
				get: {
					operationId: 'getDeliveries',
					summary: 'Inspect webhook delivery attempts for a task',
					parameters: [
						{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
					],
					responses: {
						'200': {
							description: 'Delivery records',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											total: { type: 'integer' },
											deliveries: { type: 'array' },
										},
									},
								},
							},
						},
					},
				},
			},
			'/mcp/test-callback': {
				post: {
					operationId: 'receiveTestCallback',
					summary: 'Webhook receiver endpoint for testing signed callbacks',
					description:
						'Receives POST event notifications, verifies x-mcp-event-signature HMAC if ?secret= is provided, and records telemetry.',
					parameters: [
						{ name: 'secret', in: 'query', required: false, schema: { type: 'string' } },
					],
					responses: {
						'200': {
							description: 'Recorded callback details',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											ok: { type: 'boolean' },
											received: { type: 'boolean' },
											signatureValid: { type: 'boolean' },
										},
									},
								},
							},
						},
					},
				},
				get: {
					operationId: 'getTestCallbacks',
					summary: 'List recently received test callbacks',
					responses: {
						'200': {
							description: 'List of recorded webhook callbacks',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											total: { type: 'integer' },
											callbacks: { type: 'array' },
										},
									},
								},
							},
						},
					},
				},
			},
		},
	};
}
