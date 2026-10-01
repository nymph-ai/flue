import type { McpClient, McpTransport, Tool } from '@earendil-works/pi-mcp';
import { describe, expect, it } from 'vitest';
import { createMcpConnection, createMcpConnectionCache, createMcpConnectionWithClient } from './mcp.ts';
import { assertToolDefinition, defineTool } from './tool.ts';
import { getPreparedToolAdapter } from './tool-adapter.ts';
import type { ToolDefinition } from './types.ts';

/**
 * A stub MCP client: `createMcpConnectionWithClient` only needs listTools
 * (discovery), connect/close (lifecycle), and callTool (never reached in
 * these tests). Transport is never touched — the stub ignores it.
 */
function stubClient(tools: Tool[]): Pick<McpClient, 'callTool' | 'close' | 'connect' | 'listTools'> {
	return {
		connect: async () => ({
			protocolVersion: '2025-11-25',
			capabilities: {},
			serverInfo: { name: 'stub', version: '0' },
		}),
		close: async () => {},
		listTools: async () => tools,
		callTool: async () => ({ content: [] }),
	};
}

describe('MCP tool annotations', () => {
	it("carries the server's annotations through to the adapted tool definition", async () => {
		const connection = await createMcpConnectionWithClient(
			'test',
			stubClient([
				{
					name: 'create_issue',
					title: 'Create Issue',
					description: 'Creates a new issue.',
					inputSchema: { type: 'object', properties: {}, required: [] },
					annotations: {
						title: 'Create Issue',
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: false,
						openWorldHint: false,
					},
				},
			]),
			{} as McpTransport,
		);

		expect(connection.tools).toHaveLength(1);
		const tool = connection.tools[0];
		if (!tool) throw new Error('Expected one adapted MCP tool.');
		expect(tool.name).toBe('mcp__test__create_issue');
		expect(tool.annotations).toEqual({
			title: 'Create Issue',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(Object.isFrozen(tool.annotations)).toBe(true);
		expect(Object.isFrozen(tool)).toBe(true);
		// The existing description path still reads the annotation title.
		expect(tool.description).toContain('Title: Create Issue.');
	});

	it('omits annotations when the server declares none', async () => {
		const connection = await createMcpConnectionWithClient(
			'test',
			stubClient([
				{
					name: 'search_issues',
					description: 'Searches issues.',
					inputSchema: { type: 'object', properties: {}, required: [] },
				},
			]),
			{} as McpTransport,
		);

		expect(connection.tools[0]?.annotations).toBeUndefined();
		expect(connection.tools[0]?.name).toBe('mcp__test__search_issues');
	});

	it('accepts annotations on hand-written tool definitions', () => {
		const tool = defineTool({
			name: 'wipe_data',
			description: 'Deletes everything.',
			annotations: { destructiveHint: true },
			run: () => ({ output: 'wiped' }),
		});
		expect(tool.annotations).toEqual({ destructiveHint: true });
		expect(Object.isFrozen(tool.annotations)).toBe(true);
		// The same validation path useTool() runs accepts the field.
		expect(() => assertToolDefinition(tool, 'test')).not.toThrow();
	});

	it('rejects malformed annotations in the definition validation', () => {
		expect(() =>
			assertToolDefinition(
				{
					name: 'wipe_data',
					description: 'Deletes everything.',
					annotations: { destructiveHint: 'yes' },
					run: () => undefined,
				},
				'test',
			),
		).toThrow(/annotations\.destructiveHint must be a boolean/);

		expect(() =>
			assertToolDefinition(
				{
					name: 'wipe_data',
					description: 'Deletes everything.',
					annotations: { readOnlyhint: true },
					run: () => undefined,
				},
				'test',
			),
		).toThrow(/annotations received unknown field "readOnlyhint"/);
	});
});

// ─── A Streamable HTTP server behind an injected fetch ─────────────────────

interface RecordedRequest {
	readonly method: string;
	readonly headers: Headers;
	readonly body: { method?: string; params?: Record<string, unknown> } | undefined;
	readonly init: RequestInit | undefined;
}

type ToolHandler = (args: Record<string, unknown>) => unknown;

/**
 * Just enough of the MCP Streamable HTTP server side for the client: JSON
 * responses, a session id, 202 for notifications, 405 for the optional GET
 * stream, paginated `tools/list`, and `tools/call` answered by `handlers`.
 */
function fakeMcpServer(options: {
	tools: Tool[][];
	handlers?: Record<string, ToolHandler>;
	/** Answer the next N POSTs with 401 before serving them. */
	unauthorizedFirst?: number;
}) {
	const requests: RecordedRequest[] = [];
	let unauthorized = options.unauthorizedFirst ?? 0;
	const json = (id: unknown, result: unknown) =>
		new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
			status: 200,
			headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
		});
	const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
		const method = init?.method ?? 'GET';
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		requests.push({ method, headers: new Headers(init?.headers), body, init });
		if (method === 'GET') return new Response(null, { status: 405 });
		if (method === 'DELETE') return new Response(null, { status: 200 });
		if (unauthorized > 0) {
			unauthorized--;
			return new Response('unauthorized', { status: 401 });
		}
		if (body.id === undefined) return new Response(null, { status: 202 });
		switch (body.method) {
			case 'initialize':
				return json(body.id, {
					protocolVersion: '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: 'fake', version: '1.0.0' },
				});
			case 'tools/list': {
				const index = body.params?.cursor === undefined ? 0 : Number(body.params.cursor);
				const next = index + 1 < options.tools.length ? String(index + 1) : undefined;
				return json(body.id, {
					tools: options.tools[index] ?? [],
					...(next === undefined ? {} : { nextCursor: next }),
				});
			}
			case 'tools/call': {
				const handler = options.handlers?.[body.params.name];
				if (!handler) throw new Error(`unexpected tool ${body.params.name}`);
				return json(body.id, handler(body.params.arguments ?? {}));
			}
			default:
				throw new Error(`unexpected method ${body.method}`);
		}
	};
	return { fetch: fetchImpl as unknown as typeof fetch, requests };
}

const echoTool: Tool = {
	name: 'echo',
	description: 'Echoes its input.',
	inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

function adapter(tool: ToolDefinition | undefined) {
	const prepared = tool && getPreparedToolAdapter(tool);
	if (!prepared) throw new Error('Expected an adapted MCP tool.');
	return prepared;
}

describe('createMcpConnection over pi-mcp', () => {
	it('discovers every page of tools and calls them over Streamable HTTP', async () => {
		const server = fakeMcpServer({
			tools: [[echoTool], [{ ...echoTool, name: 'shout' }]],
			handlers: {
				echo: (args) => ({ content: [{ type: 'text', text: `echo: ${String(args.text)}` }] }),
				shout: (args) => ({ content: [{ type: 'text', text: String(args.text).toUpperCase() }] }),
			},
		});
		const connection = await createMcpConnection({
			name: 'docs',
			url: 'https://mcp.example.test/mcp',
			fetch: server.fetch,
		});
		try {
			expect(connection.tools.map((tool) => tool.name)).toEqual(['mcp__docs__echo', 'mcp__docs__shout']);
			const echo = adapter(connection.tools[0]);
			expect(echo.parameters).toEqual({
				type: 'object',
				properties: { text: { type: 'string' } },
				required: undefined,
			});
			await expect(echo.execute({ text: 'hi' })).resolves.toBe('echo: hi');
			await expect(adapter(connection.tools[1]).execute({ text: 'hi' })).resolves.toBe('HI');
			const initialize = server.requests.find((request) => request.body?.method === 'initialize');
			expect(initialize?.body?.params?.clientInfo).toMatchObject({ name: 'flue' });
			// The session id the server assigned rides every later request.
			const call = server.requests.find((request) => request.body?.method === 'tools/call');
			expect(call?.headers.get('mcp-session-id')).toBe('session-1');
		} finally {
			await connection.close();
		}
	});

	it('sends the bearer credential per request and re-resolves it after a 401', async () => {
		const server = fakeMcpServer({ tools: [[echoTool]], unauthorizedFirst: 1 });
		let issued = 0;
		const connection = await createMcpConnection({
			name: 'docs',
			url: 'https://mcp.example.test/mcp',
			fetch: server.fetch,
			auth: () => `token-${++issued}`,
		});
		await connection.close();
		const posts = server.requests.filter((request) => request.method === 'POST');
		// The rejected initialize carried token-1; the retry re-resolved it.
		expect(posts[0]?.headers.get('authorization')).toBe('Bearer token-1');
		expect(posts[1]?.headers.get('authorization')).toBe('Bearer token-2');
		expect(posts[1]?.body?.method).toBe('initialize');
		for (const post of posts.slice(1)) {
			expect(post.headers.get('authorization')).toMatch(/^Bearer token-\d+$/);
		}
	});

	it('merges requestInit and static headers, headers winning, and applies the rest of requestInit', async () => {
		const server = fakeMcpServer({ tools: [[echoTool]] });
		const connection = await createMcpConnection({
			name: 'docs',
			url: 'https://mcp.example.test/mcp',
			fetch: server.fetch,
			requestInit: {
				headers: { 'x-tenant': 'from-init', 'x-init-only': 'kept' },
				redirect: 'error',
			},
			headers: { 'x-tenant': 'from-headers' },
		});
		await connection.close();
		const initialize = server.requests.find((request) => request.body?.method === 'initialize');
		expect(initialize?.headers.get('x-tenant')).toBe('from-headers');
		expect(initialize?.headers.get('x-init-only')).toBe('kept');
		expect(initialize?.init?.redirect).toBe('error');
		// Protocol headers are the transport's, not overridden by requestInit.
		expect(initialize?.headers.get('content-type')).toBe('application/json');
	});

	it('formats results with pi-mcp toLlmContent and throws on isError', async () => {
		const server = fakeMcpServer({
			tools: [[{ ...echoTool, name: 'structured' }, { ...echoTool, name: 'mixed' }, { ...echoTool, name: 'fails' }]],
			handlers: {
				structured: () => ({ content: [], structuredContent: { answer: 42 } }),
				mixed: () => ({
					content: [
						{ type: 'text', text: 'summary' },
						{ type: 'resource', resource: { uri: 'file:///notes.md', text: 'embedded text' } },
						{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
					],
				}),
				fails: () => ({ content: [{ type: 'text', text: 'server said no' }], isError: true }),
			},
		});
		const connection = await createMcpConnection({
			name: 'docs',
			url: 'https://mcp.example.test/mcp',
			fetch: server.fetch,
		});
		try {
			const [structured, mixed, fails] = connection.tools;
			await expect(adapter(structured).execute({})).resolves.toBe('{\n  "answer": 42\n}');
			await expect(adapter(mixed).execute({})).resolves.toBe(
				'summary\n\nembedded text\n\n[Image: image/png, 8 base64 chars]',
			);
			await expect(adapter(fails).execute({})).rejects.toThrow('server said no');
		} finally {
			await connection.close();
		}
	});

	it('refuses legacy SSE servers with an explicit error instead of falling back', async () => {
		const server = fakeMcpServer({ tools: [[echoTool]] });
		await expect(
			createMcpConnection({
				name: 'legacy',
				url: 'https://mcp.example.test/sse',
				transport: 'sse',
				fetch: server.fetch,
			}),
		).rejects.toThrow(/legacy HTTP\+SSE transport.*not support/);
		expect(server.requests).toHaveLength(0);
	});

	it('does not cache a failed connection', async () => {
		const cache = createMcpConnectionCache();
		const definition = {
			name: 'legacy',
			url: 'https://mcp.example.test/sse',
			transport: 'sse' as const,
		};
		const first = cache.resolve(definition);
		await expect(first).rejects.toThrow(/legacy HTTP\+SSE/);
		const second = cache.resolve(definition);
		expect(second).not.toBe(first);
		await expect(second).rejects.toThrow(/legacy HTTP\+SSE/);
		await cache.close();
	});
});
