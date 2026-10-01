/**
 * The MCP client against real servers from `@modelcontextprotocol/server`,
 * in process: a stateless 2026-07-28 endpoint (`createMcpHandler`), and a
 * 2025-11-25-only endpoint (a sessionful Streamable HTTP transport that
 * refuses the 2026 envelope). Every request goes through an injected
 * `fetch`, which records what crossed the wire.
 */
import {
	createMcpHandler,
	isLegacyRequest,
	Server,
	WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createMcpConnection,
	createMcpConnectionCache,
	McpInputRequiredError,
	mcpToolName,
} from './mcp.ts';
import type { McpConnectionDefinition } from './mcp-types.ts';
import { getMcpToolSource, getPreparedToolAdapter } from './tool-adapter.ts';
import type { ToolDefinition } from './types.ts';

const URL_MODERN = 'https://modern.test/mcp';
const URL_LEGACY = 'https://legacy.test/mcp';

/** A tiny PNG's worth of base64. */
const PIXEL =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type ToolSpec = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	run: (args: Record<string, unknown>) => unknown;
};

function buildServer(tools: readonly ToolSpec[], listing: { ttlMs?: number } = {}): Server {
	const server = new Server(
		{ name: 'test-server', version: '1.0.0' },
		{ capabilities: { tools: {} }, instructions: 'A server for tests.' },
	);
	server.setRequestHandler('tools/list', (async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			...(tool.description ? { description: tool.description } : {}),
			inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
			...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		})),
		...(listing.ttlMs !== undefined ? { ttlMs: listing.ttlMs, cacheScope: 'private' } : {}),
	})) as never);
	server.setRequestHandler('tools/call', (async (request: {
		params: { name: string; arguments?: Record<string, unknown> };
	}) => {
		const tool = tools.find((candidate) => candidate.name === request.params.name);
		if (!tool) return { content: [{ type: 'text', text: 'no such tool' }], isError: true };
		return tool.run(request.params.arguments ?? {});
	}) as never);
	return server;
}

type Seen = {
	method: string | undefined;
	url: string;
	httpMethod: string;
	sessionId: string | null;
};

function recorder() {
	const seen: Seen[] = [];
	const record = async (request: Request) => {
		let method: string | undefined;
		if (request.method === 'POST') {
			try {
				method = ((await request.clone().json()) as { method?: string }).method;
			} catch {}
		}
		seen.push({
			method,
			url: request.url,
			httpMethod: request.method,
			sessionId: request.headers.get('mcp-session-id'),
		});
	};
	return { seen, record };
}

/** A stateless 2026-07-28 server (no 2025 fallback). */
function modernServer(tools: readonly ToolSpec[], listing: { ttlMs?: number } = {}) {
	const handler = createMcpHandler(() => buildServer(tools, listing), {
		legacy: 'reject',
		responseMode: 'json',
	});
	const { seen, record } = recorder();
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		await record(request);
		return handler.fetch(request);
	}) as typeof fetch;
	return { seen, fetch: fetchFn };
}

/** A 2025-11-25 server: sessions, no `server/discover`. `forget()` drops every session. */
function legacyServer(tools: readonly ToolSpec[]) {
	const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
	const { seen, record } = recorder();
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		await record(request);
		if (request.method === 'POST' && !(await isLegacyRequest(request.clone()))) {
			// What a 2025-era server answers to an unknown pre-initialize request.
			return Response.json(
				{
					jsonrpc: '2.0',
					id: null,
					error: { code: -32000, message: 'Bad Request: Server not initialized' },
				},
				{ status: 400 },
			);
		}
		const sessionId = request.headers.get('mcp-session-id');
		if (sessionId) {
			const transport = sessions.get(sessionId);
			if (!transport)
				return Response.json(
					{ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } },
					{ status: 404 },
				);
			return transport.handleRequest(request);
		}
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			enableJsonResponse: true,
			onsessioninitialized: (id) => {
				sessions.set(id, transport);
			},
		});
		await buildServer(tools).connect(transport);
		return transport.handleRequest(request);
	}) as typeof fetch;
	return { seen, fetch: fetchFn, forget: () => sessions.clear() };
}

const echo: ToolSpec = {
	name: 'echo',
	description: 'Echo the text back.',
	inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	run: (args) => ({ content: [{ type: 'text', text: `echo: ${String(args.text)}` }] }),
};

async function run(tool: ToolDefinition | undefined, args: Record<string, unknown>) {
	const adapter = tool && getPreparedToolAdapter(tool);
	if (!adapter) throw new Error('expected an adapted MCP tool');
	return adapter.execute(args);
}

function textOf(output: Awaited<ReturnType<typeof run>>): string {
	return typeof output === 'string'
		? output
		: output.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

afterEach(() => {
	vi.useRealTimers();
});

describe('stateless MCP (2026-07-28)', () => {
	it('discovers with server/discover, never initializes, and carries no session', async () => {
		const server = modernServer([echo]);
		const connection = await createMcpConnection({
			name: 'docs',
			url: URL_MODERN,
			fetch: server.fetch,
		});
		expect(connection.tools.map((tool) => tool.name)).toEqual(['mcp__docs__echo']);
		expect(textOf(await run(connection.tools[0], { text: 'hi' }))).toBe('echo: hi');
		await connection.close();

		const methods = server.seen.map((request) => request.method);
		expect(methods).toContain('server/discover');
		expect(methods).toContain('tools/list');
		expect(methods).toContain('tools/call');
		expect(methods).not.toContain('initialize');
		expect(server.seen.every((request) => request.sessionId === null)).toBe(true);
		// No standing stream: nothing but POSTs reached the server.
		expect(server.seen.every((request) => request.httpMethod === 'POST')).toBe(true);
	});

	it('a fresh client after an eviction works mid-conversation, with no state carried over', async () => {
		const server = modernServer([echo]);
		const definition: McpConnectionDefinition = {
			name: 'docs',
			url: URL_MODERN,
			fetch: server.fetch,
		};
		const before = createMcpConnectionCache();
		const first = await before.resolve(definition);
		expect(textOf(await run(first.tools[0], { text: 'one' }))).toBe('echo: one');
		// The isolate is evicted: the cache and its client are gone. Nothing is closed politely.
		const after = createMcpConnectionCache();
		const second = await after.resolve(definition);
		expect(textOf(await run(second.tools[0], { text: 'two' }))).toBe('echo: two');
		expect(server.seen.some((request) => request.method === 'initialize')).toBe(false);
		await after.close();
	});

	it('honours the listing cache hint: no re-list before ttlMs, a refresh after', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const server = modernServer([echo], { ttlMs: 30_000 });
		const cache = createMcpConnectionCache();
		const definition: McpConnectionDefinition = {
			name: 'docs',
			url: URL_MODERN,
			fetch: server.fetch,
		};
		await cache.resolve(definition);
		await cache.resolve(definition);
		const lists = () => server.seen.filter((request) => request.method === 'tools/list').length;
		expect(lists()).toBe(1);
		vi.setSystemTime(Date.now() + 31_000);
		await cache.resolve(definition);
		expect(lists()).toBe(2);
		await cache.close();
	});

	it('passes images through and returns structured content when there is no text', async () => {
		const server = modernServer([
			{
				name: 'snapshot',
				run: () => ({
					content: [
						{ type: 'text', text: 'a frame' },
						{ type: 'image', data: PIXEL, mimeType: 'image/png' },
					],
				}),
			},
			{
				name: 'stats',
				outputSchema: {
					type: 'object',
					properties: { count: { type: 'number' } },
					required: ['count'],
				},
				run: () => ({ content: [], structuredContent: { count: 3 } }),
			},
		]);
		const connection = await createMcpConnection({
			name: 'cam',
			url: URL_MODERN,
			fetch: server.fetch,
		});
		const [snapshot, stats] = connection.tools;
		expect(await run(snapshot, {})).toEqual([
			{ type: 'text', text: 'a frame' },
			{ type: 'image', data: PIXEL, mimeType: 'image/png' },
		]);
		expect(JSON.parse(textOf(await run(stats, {})))).toEqual({ count: 3 });
		// Code Mode reads the source: the server's output schema, intact.
		expect(getMcpToolSource(stats as ToolDefinition)?.tool.outputSchema).toEqual({
			type: 'object',
			properties: { count: { type: 'number' } },
			required: ['count'],
		});
		await connection.close();
	});

	it('fails an input_required answer with an error naming the requested inputs', async () => {
		const server = modernServer([echo]);
		// The 2026 server SDK refuses to ask a client that declared no
		// elicitation capability, as it should; this server ignores that rule.
		const asking = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (request.method === 'POST') {
				const body = (await request.clone().json()) as { id?: number; method?: string };
				if (body.method === 'tools/call') {
					return Response.json({
						jsonrpc: '2.0',
						id: body.id,
						result: {
							resultType: 'input_required',
							inputRequests: {
								confirm: {
									method: 'elicitation/create',
									params: {
										mode: 'form',
										message: 'Deploy to production?',
										requestedSchema: {
											type: 'object',
											properties: { approved: { type: 'boolean' } },
										},
									},
								},
							},
						},
					});
				}
			}
			return server.fetch(request);
		}) as typeof fetch;
		const connection = await createMcpConnection({ name: 'ops', url: URL_MODERN, fetch: asking });
		const failure = await run(connection.tools[0], { text: 'x' }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(McpInputRequiredError);
		const message = (failure as Error).message;
		expect(message).toContain('"confirm"');
		expect(message).toContain('elicitation/create');
		expect(message).toContain('Deploy to production?');
		expect(message).toContain('approved');
		await connection.close();
	});
});

describe('servers on earlier revisions (2025-11-25)', () => {
	it('negotiates down to initialize and works over a session', async () => {
		const server = legacyServer([echo]);
		const connection = await createMcpConnection({
			name: 'old',
			url: URL_LEGACY,
			fetch: server.fetch,
		});
		expect(textOf(await run(connection.tools[0], { text: 'legacy' }))).toBe('echo: legacy');
		await connection.close();
		const methods = server.seen.map((request) => request.method);
		expect(methods).toContain('initialize');
		expect(server.seen.some((request) => request.sessionId !== null)).toBe(true);
		// The 2025 standalone GET stream never left the agent.
		expect(server.seen.some((request) => request.httpMethod === 'GET')).toBe(false);
	});

	it('recovers when the server forgets the session (HTTP 404) and retries once', async () => {
		const server = legacyServer([echo]);
		const cache = createMcpConnectionCache();
		const connection = await cache.resolve({ name: 'old', url: URL_LEGACY, fetch: server.fetch });
		expect(textOf(await run(connection.tools[0], { text: 'one' }))).toBe('echo: one');
		server.forget();
		expect(textOf(await run(connection.tools[0], { text: 'two' }))).toBe('echo: two');
		expect(server.seen.filter((request) => request.method === 'initialize')).toHaveLength(2);
		await cache.close();
	});
});

describe('tool names', () => {
	it('keeps safe names readable', () => {
		expect(mcpToolName('linear', 'create_issue')).toBe('mcp__linear__create_issue');
		expect(mcpToolName('my-server', 'get-user')).toBe('mcp__my-server__get-user');
	});

	it('never maps two different tools to one name', () => {
		const pairs: [string, string][] = [
			['srv', 'get-user'],
			['srv', 'get_user'],
			['srv', 'get user'],
			['srv', 'get.user'],
			['a', 'b__c'],
			['a__b', 'c'],
			['a_', 'b'],
			['a', '_b'],
			['srv', 'x'.repeat(80)],
			['srv', `${'x'.repeat(79)}y`],
		];
		const names = pairs.map(([server, tool]) => mcpToolName(server, tool));
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) {
			expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		}
	});

	it('adapts a server listing tools that differ only by - and _', async () => {
		const server = modernServer([
			{ name: 'get-user', run: () => ({ content: [{ type: 'text', text: 'dash' }] }) },
			{ name: 'get_user', run: () => ({ content: [{ type: 'text', text: 'underscore' }] }) },
		]);
		const connection = await createMcpConnection({
			name: 'people',
			url: URL_MODERN,
			fetch: server.fetch,
		});
		const [dash, underscore] = connection.tools;
		expect(dash?.name).not.toBe(underscore?.name);
		expect(textOf(await run(dash, {}))).toBe('dash');
		expect(textOf(await run(underscore, {}))).toBe('underscore');
		await connection.close();
	});
});

describe('connection definitions', () => {
	it('applies the allowlist in order and rejects unknown names', async () => {
		const server = modernServer([echo, { name: 'other', run: () => ({ content: [] }) }]);
		const connection = await createMcpConnection({
			name: 'docs',
			url: URL_MODERN,
			fetch: server.fetch,
			tools: ['other', 'echo'],
		});
		expect(connection.tools.map((tool) => tool.name)).toEqual([
			'mcp__docs__other',
			'mcp__docs__echo',
		]);
		await connection.close();
		await expect(
			createMcpConnection({
				name: 'docs',
				url: URL_MODERN,
				fetch: server.fetch,
				tools: ['missing'],
			}),
		).rejects.toThrow(/does not expose "missing"/);
	});

	it('sends the bearer token on every request', async () => {
		const server = modernServer([echo]);
		const tokens: (string | null)[] = [];
		const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			tokens.push(request.headers.get('authorization'));
			return server.fetch(request);
		}) as typeof fetch;
		const connection = await createMcpConnection({
			name: 'docs',
			url: URL_MODERN,
			fetch: fetchFn,
			auth: () => 'secret',
		});
		await run(connection.tools[0], { text: 'x' });
		await connection.close();
		expect(tokens.length).toBeGreaterThan(0);
		expect(tokens.every((token) => token === 'Bearer secret')).toBe(true);
	});

	it('refuses legacy SSE, and stdio where no stdio transport is installed', async () => {
		await expect(
			createMcpConnection({ name: 'old', url: URL_LEGACY, transport: 'sse' }),
		).rejects.toThrow(/legacy HTTP\+SSE transport/);
		await expect(
			createMcpConnection({ name: 'local', transport: 'stdio', command: 'mcp-server' }),
		).rejects.toThrow(/cannot start processes/);
	});
});
