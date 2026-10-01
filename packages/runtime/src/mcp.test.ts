/**
 * The MCP client against real servers from `@modelcontextprotocol/server`,
 * in process: a stateless 2026-07-28 endpoint (`createMcpHandler`), and a
 * 2025-11-25-only endpoint (a sessionful Streamable HTTP transport that
 * refuses the 2026 envelope), which Flue must refuse. Every request goes
 * through an injected `fetch`, which records what crossed the wire.
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
	McpProtocolVersionError,
	mcpToolName,
} from './mcp.ts';
import type { McpConnectionDefinition } from './mcp-types.ts';
import {
	type FlueQuestion,
	QuestionParkedError,
	setQuestionHandler,
} from './questions.ts';
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

/** A 2025-11-25 server: sessions, no `server/discover`. */
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
	return { seen, fetch: fetchFn };
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
	setQuestionHandler(undefined);
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

	/** A server whose tools/call asks for confirmation once, then answers with what it got. */
	function askingServer() {
		const server = modernServer([echo]);
		const calls: Record<string, unknown>[] = [];
		const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (request.method === 'POST') {
				const body = (await request.clone().json()) as {
					id?: number;
					method?: string;
					params?: Record<string, unknown>;
				};
				if (body.method === 'tools/call') {
					calls.push(body.params ?? {});
					if (body.params?.inputResponses) {
						return Response.json({
							jsonrpc: '2.0',
							id: body.id,
							result: {
								content: [
									{
										type: 'text',
										text: `deployed with ${JSON.stringify(body.params.inputResponses)} and ${String(body.params.requestState)}`,
									},
								],
							},
						});
					}
					// The 2026 server SDK refuses to ask a client that declared no
					// elicitation capability, as it should; this server ignores that rule.
					return Response.json({
						jsonrpc: '2.0',
						id: body.id,
						result: {
							resultType: 'input_required',
							requestState: 'opaque-state-1',
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
		return { calls, fetch: fetchFn };
	}

	it('fails input_required with an error naming the requested inputs while questions are not wired', async () => {
		const server = askingServer();
		const connection = await createMcpConnection({
			name: 'ops',
			url: URL_MODERN,
			fetch: server.fetch,
		});
		const failure = await run(connection.tools[0], { text: 'x' }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(McpInputRequiredError);
		const message = (failure as Error).message;
		expect(message).toContain('"confirm"');
		expect(message).toContain('elicitation/create');
		expect(message).toContain('Deploy to production?');
		expect(message).toContain('approved');
		expect(message).toContain('questions are not wired');
		await connection.close();
	});

	it('puts input_required to the question seam and retries with the answers and the request state', async () => {
		const server = askingServer();
		const asked: FlueQuestion[] = [];
		setQuestionHandler(async (question) => {
			asked.push(question);
			return { kind: 'mcp-input', inputResponses: { confirm: { action: 'accept', content: { approved: true } } } };
		});
		const connection = await createMcpConnection({
			name: 'ops',
			url: URL_MODERN,
			fetch: server.fetch,
		});
		const text = textOf(await run(connection.tools[0], { text: 'x' }));
		expect(text).toBe('deployed with {"confirm":{"action":"accept","content":{"approved":true}}} and opaque-state-1');
		expect(asked).toHaveLength(1);
		const question = asked[0];
		expect(question?.kind).toBe('mcp-input');
		if (question?.kind !== 'mcp-input') throw new Error('expected an mcp-input question');
		expect(question.server).toBe('ops');
		expect(question.method).toBe('tools/call');
		expect(question.params).toMatchObject({ name: 'echo', arguments: { text: 'x' } });
		expect(question.requestState).toBe('opaque-state-1');
		expect(Object.keys(question.inputRequests)).toEqual(['confirm']);
		expect(question.id).toMatch(/^mcp:ops:[0-9a-f]{16}$/);
		// The retry carried the answers and echoed the state byte for byte.
		expect(server.calls.at(-1)).toMatchObject({
			name: 'echo',
			requestState: 'opaque-state-1',
			inputResponses: { confirm: { action: 'accept' } },
		});
		await connection.close();
	});

	it('ends the call with the parked error when the seam parks the question', async () => {
		const server = askingServer();
		setQuestionHandler(async (question) => {
			throw new QuestionParkedError(question);
		});
		const connection = await createMcpConnection({
			name: 'ops',
			url: URL_MODERN,
			fetch: server.fetch,
		});
		const failure = await run(connection.tools[0], { text: 'x' }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(QuestionParkedError);
		expect((failure as QuestionParkedError).question.id).toMatch(/^mcp:ops:/);
		expect(server.calls).toHaveLength(1);
		await connection.close();
	});
});

describe('servers on earlier revisions are refused', () => {
	it('refuses a 2025-only server with one error naming it and its server/discover answer', async () => {
		const server = legacyServer([echo]);
		const failure = await createMcpConnection({
			name: 'old',
			url: URL_LEGACY,
			fetch: server.fetch,
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(McpProtocolVersionError);
		const message = (failure as Error).message;
		expect(message).toContain('MCP server "old" (https://legacy.test/mcp)');
		expect(message).toContain('does not speak MCP 2026-07-28');
		expect(message).toContain('server/discover answer: HTTP 400, JSON-RPC error -32000');
		expect(message).toContain('Server not initialized');
		// No fallback: the 2025 handshake was never attempted, and no session exists.
		const methods = server.seen.map((request) => request.method);
		expect(methods).toEqual(['server/discover']);
		expect(server.seen.every((request) => request.sessionId === null)).toBe(true);
	});

	it('names the versions a server offers when none is 2026-07-28', async () => {
		const offering = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const body = (await request.clone().json()) as { id?: number };
			return Response.json(
				{
					jsonrpc: '2.0',
					id: body.id ?? null,
					error: {
						code: -32022,
						message: 'Unsupported protocol version',
						data: { supported: ['2025-06-18', '2025-11-25'], requested: '2026-07-28' },
					},
				},
				{ status: 400 },
			);
		}) as typeof fetch;
		const failure = await createMcpConnection({
			name: 'older',
			url: URL_LEGACY,
			fetch: offering,
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(McpProtocolVersionError);
		expect((failure as McpProtocolVersionError).offered).toEqual(['2025-06-18', '2025-11-25']);
		expect((failure as Error).message).toContain('It offered: 2025-06-18, 2025-11-25.');
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

	it('refuses legacy SSE', async () => {
		await expect(
			createMcpConnection({ name: 'old', url: URL_LEGACY, transport: 'sse' }),
		).rejects.toThrow(/legacy HTTP\+SSE transport/);
	});
});
