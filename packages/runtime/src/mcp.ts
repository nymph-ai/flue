// Only these three names are imported: the pi-mcp root also re-exports
// `StdioTransport` (node:child_process, cross-spawn), which the package's
// `sideEffects: false` lets the bundler drop, and which workerd could not
// load. @flue/vite aliases both modules to throwing stubs on the Cloudflare
// target as a backstop (PI_UPGRADE_PLAN.md §6).
import {
	type AuthProvider,
	type CallToolResult,
	McpClient,
	type McpFetch,
	type McpRequestOptions,
	type McpTransport as PiMcpTransport,
	StreamableHttpTransport,
	type Tool,
	toLlmContent,
} from '@earendil-works/pi-mcp';
import { version as runtimeVersion } from '../package.json' with { type: 'json' };
import type { McpAuth, McpConnectionDefinition, McpTransport } from './mcp-types.ts';
import { registerPreparedToolAdapter } from './tool-adapter.ts';
import type { ToolDefinition } from './types.ts';

export type {
	McpAuth,
	McpConnectionDefinition,
	McpToolAnnotations,
	McpTransport,
} from './mcp-types.ts';

/**
 * The per-request timeout Flue has always documented for `timeoutMs`. pi-mcp's
 * own default is 30 seconds; the connection keeps Flue's.
 */
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;

/** Per-request behaviour shared by discovery and tool calls. */
type McpCallOptions = {
	/**
	 * Renew the request timeout on server progress. pi-mcp renews it whenever a
	 * progress notification arrives for a request that asked for progress, and
	 * only asks when an `onProgress` listener is supplied.
	 */
	resetTimeoutOnProgress?: boolean;
};

/** Connection returned by {@link createMcpConnection}. */
export interface McpConnection {
	/** Server name supplied to {@link createMcpConnection}. */
	name: string;
	/** MCP tools adapted into ordinary Flue tool definitions. */
	tools: ToolDefinition[];
	/** Close the underlying MCP client connection. */
	close(): Promise<void>;
}

/**
 * Resolves `useMcpConnection()` declarations to live connections.
 * Coordinators inject a per-instance caching resolver; a context without one
 * connects fresh at every harness initialization.
 */
export interface McpConnectionResolver {
	resolve(definition: McpConnectionDefinition): Promise<McpConnection>;
}

/** A caching {@link McpConnectionResolver} with a teardown for coordinator shutdown. */
export interface McpConnectionCache extends McpConnectionResolver {
	/** Close every cached connection and forget them all. */
	close(): Promise<void>;
}

/**
 * A per-instance MCP connection cache: the first declaration of a server
 * name connects; later submissions reuse the live connection for the
 * instance's in-memory lifetime, so definitions are read at first connect
 * (an `auth` resolver stays per-request). Concurrent resolves of one name
 * share a single in-flight connect. A failed connect is evicted immediately —
 * a transient outage must not brick the instance, so the next submission
 * retries with a freshly read definition.
 */
export function createMcpConnectionCache(): McpConnectionCache {
	const connections = new Map<string, Promise<McpConnection>>();
	return {
		resolve(definition: McpConnectionDefinition): Promise<McpConnection> {
			const cached = connections.get(definition.name);
			if (cached) return cached;
			const pending = createMcpConnection(definition);
			connections.set(definition.name, pending);
			pending.catch(() => {
				if (connections.get(definition.name) === pending) {
					connections.delete(definition.name);
				}
			});
			return pending;
		},
		async close(): Promise<void> {
			const pending = [...connections.values()];
			connections.clear();
			await Promise.allSettled(pending.map(async (connection) => (await connection).close()));
		},
	};
}

/**
 * Connects to a remote MCP server described by a
 * {@link McpConnectionDefinition} and adapts its listed tools into ordinary
 * Flue tool definitions.
 *
 * Adapted tool names use `mcp__<server>__<tool>`. Unsupported characters are
 * replaced with underscores, and duplicate adapted names are rejected. Close
 * the returned connection when its tools are no longer needed.
 */
export async function createMcpConnection(
	definition: McpConnectionDefinition,
): Promise<McpConnection> {
	const transport = createTransport(definition);
	const client = new McpClient({
		name: 'flue',
		version: runtimeVersion,
		requestTimeoutMs: definition.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
	});

	return createMcpConnectionWithClient(
		definition.name,
		client,
		transport,
		{ resetTimeoutOnProgress: definition.resetTimeoutOnProgress },
		{ tools: definition.tools },
	);
}

/** The slice of pi-mcp's {@link McpClient} a connection uses. */
type McpConnectionClient = Pick<McpClient, 'callTool' | 'close' | 'connect' | 'listTools'>;

export async function createMcpConnectionWithClient(
	name: string,
	client: McpConnectionClient,
	transport: PiMcpTransport,
	callOptions: McpCallOptions = {},
	selection: { tools?: readonly string[] } = {},
): Promise<McpConnection> {
	try {
		await client.connect(transport);
		// pi-mcp follows `nextCursor` through every page and rejects a server
		// that repeats a cursor, so discovery cannot loop.
		const tools = await client.listTools(progressOptions(callOptions));

		return {
			name,
			tools: createMcpTools(
				name,
				client,
				selectMcpTools(name, tools, selection.tools),
				callOptions,
			),
			close: () => client.close(),
		};
	} catch (error) {
		await client.close().catch(() => undefined);
		throw error;
	}
}

/**
 * Adapt the `auth` credential to pi-mcp's {@link AuthProvider}: the transport
 * calls `token()` before every request, and on a 401 (or a 403 asking for more
 * scope) awaits `onUnauthorized` and retries once — re-resolving the token, so
 * the application's credential store is the refresh policy.
 */
function createAuthProvider(auth: McpAuth): AuthProvider {
	const resolveToken = typeof auth === 'function' ? auth : () => auth;
	return {
		token: async () => resolveToken(),
		onUnauthorized: async () => {},
	};
}

/**
 * Apply the `tools` allowlist to the discovered listing, in allowlist order.
 * Every allowlisted name must exist and be callable — a typo or an
 * unsupported tool must fail loud, not silently narrow the tool set.
 */
function selectMcpTools(
	serverName: string,
	discovered: Tool[],
	allowlist: readonly string[] | undefined,
): Tool[] {
	if (allowlist === undefined) return discovered;
	const byName = new Map(discovered.map((tool) => [tool.name, tool]));
	const duplicates = allowlist.filter((name, index) => allowlist.indexOf(name) !== index);
	if (duplicates.length > 0) {
		throw new Error(
			`[flue] MCP server "${serverName}" tools allowlist repeats ${formatToolNames(duplicates)}.`,
		);
	}
	const unknown = allowlist.filter((name) => !byName.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`[flue] MCP server "${serverName}" does not expose ${formatToolNames(unknown)} named in the tools allowlist. Discovered tools: ${
				discovered.map((tool) => tool.name).join(', ') || '(none)'
			}.`,
		);
	}
	return allowlist.map((name) => {
		const tool = byName.get(name) as Tool;
		if (tool.execution?.taskSupport === 'required') {
			throw new Error(
				`[flue] MCP tool "${name}" from server "${serverName}" requires task-based execution, which is not supported — remove it from the tools allowlist.`,
			);
		}
		return tool;
	});
}

function formatToolNames(names: readonly string[]): string {
	return [...new Set(names)].map((name) => JSON.stringify(name)).join(', ');
}

/**
 * The Streamable HTTP transport for a definition. Legacy HTTP+SSE servers are
 * refused explicitly: pi-mcp implements only Streamable HTTP (and stdio, which
 * Flue does not expose), and silently trying Streamable HTTP against an SSE
 * endpoint would fail later with a misleading protocol error.
 */
function createTransport(definition: McpConnectionDefinition): StreamableHttpTransport {
	const transport: McpTransport = definition.transport ?? 'streamable-http';
	if (transport === 'sse') {
		throw new Error(
			`[flue] MCP server "${definition.name}" is declared with transport 'sse' (the legacy HTTP+SSE transport), which the MCP client does not support. ` +
				"Point `url` at the server's Streamable HTTP endpoint and drop `transport: 'sse'` — servers that still offer legacy SSE almost always serve Streamable HTTP too.",
		);
	}
	const { headers: initHeaders, ...init } = definition.requestInit ?? {};
	return new StreamableHttpTransport({
		url: definition.url,
		headers: mergeHeaders(initHeaders, definition.headers),
		fetch: createFetch(definition.fetch, init),
		...(definition.auth === undefined ? {} : { authProvider: createAuthProvider(definition.auth) }),
	});
}

/**
 * `requestInit` headers first, then `headers` (set wins), as a plain record —
 * the shape pi-mcp takes. Per-request protocol headers still override both.
 */
function mergeHeaders(
	initHeaders: HeadersInit | undefined,
	headers: HeadersInit | undefined,
): Record<string, string> {
	const merged = new Headers(initHeaders);
	for (const [key, value] of new Headers(headers)) merged.set(key, value);
	return Object.fromEntries(merged);
}

/**
 * pi-mcp has no `requestInit`: it hands `fetch` only method, headers, body and
 * its own abort signal. The rest of `requestInit` (credentials, cache,
 * redirect, a caller signal, …) is applied by wrapping `fetch`, under the
 * transport's per-request fields. Without any, the transport keeps its default.
 */
function createFetch(
	baseFetch: typeof fetch | undefined,
	init: Omit<RequestInit, 'headers'>,
): McpFetch | undefined {
	if (Object.keys(init).length === 0) return baseFetch;
	return (input, request) => {
		const signals = [init.signal, request?.signal].filter(
			(signal): signal is AbortSignal => signal !== undefined && signal !== null,
		);
		return (baseFetch ?? fetch)(input, {
			...init,
			...request,
			...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
		});
	};
}

function progressOptions(callOptions: McpCallOptions): McpRequestOptions {
	return callOptions.resetTimeoutOnProgress ? { onProgress: () => {} } : {};
}

function createMcpTools(
	serverName: string,
	client: McpConnectionClient,
	tools: Tool[],
	callOptions: McpCallOptions,
): ToolDefinition[] {
	const names = new Set<string>();

	const callableTools = tools.filter((tool) => {
		if (tool.execution?.taskSupport !== 'required') return true;
		console.warn(
			`[flue] Skipping MCP tool "${tool.name}" from server "${serverName}": it requires task-based execution, which is not supported.`,
		);
		return false;
	});

	return callableTools.map((tool) => {
		const toolName = createToolName(serverName, tool.name);
		if (names.has(toolName)) {
			throw new Error(
				`[flue] MCP tools from server "${serverName}" produced duplicate tool name "${toolName}".`,
			);
		}
		names.add(toolName);

		const definition: ToolDefinition = {
			name: toolName,
			description: createToolDescription(serverName, tool),
			input: undefined,
			output: undefined,
			// Carry the server's `tools/list` annotations through so application
			// code can gate on readOnlyHint / destructiveHint / idempotentHint /
			// openWorldHint. The copy is frozen like the definition itself —
			// adapted tools are data, not handles.
			...(tool.annotations === undefined
				? {}
				: { annotations: Object.freeze({ ...tool.annotations }) }),
			run() {
				throw new Error('[flue] MCP tools execute through the internal adapter.');
			},
		};
		registerPreparedToolAdapter(definition, {
			parameters: normalizeInputSchema(tool.inputSchema),
			async execute(args, signal) {
				if (signal?.aborted) throw new Error('Operation aborted');
				const result = await client.callTool(tool.name, args, {
					...progressOptions(callOptions),
					...(signal === undefined ? {} : { signal }),
				});
				const text = formatMcpResult(result);
				if (result.isError) {
					throw new Error(text);
				}
				return text;
			},
		});
		return Object.freeze(definition);
	});
}

function createToolName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
}

function sanitizeToolNamePart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
	return sanitized || 'unnamed';
}

function createToolDescription(serverName: string, tool: Tool): string {
	const parts: string[] = [];
	// The adapted name parses back to the original ("mcp__linear__create_issue")
	// unless sanitization altered a part — only then does the mapping need
	// spelling out, so server descriptions that cross-reference sibling tools
	// by their original names stay followable.
	const sanitized =
		sanitizeToolNamePart(serverName) !== serverName ||
		sanitizeToolNamePart(tool.name) !== tool.name;
	if (sanitized) parts.push(`MCP tool "${tool.name}" from server "${serverName}".`);
	const title = tool.title ?? tool.annotations?.title;
	if (title && title !== tool.name) parts.push(`Title: ${title}.`);
	if (tool.description) parts.push(tool.description);
	if (parts.length === 0) parts.push(`MCP tool "${tool.name}" from server "${serverName}".`);
	return parts.join(' ');
}

function normalizeInputSchema(schema: Tool['inputSchema']): object {
	return {
		...schema,
		type: schema.type ?? 'object',
		properties: schema.properties ?? {},
		required: schema.required,
	};
}

/**
 * The model-facing text of a tool result, through pi-mcp's `toLlmContent`:
 * text passes through, embedded text resources are unwrapped, audio, links and
 * binary resources become short placeholders, and `structuredContent` is used
 * only when the server sent no content blocks (servers mirror structured
 * results as text). Flue's prepared-tool adapter returns one string, so images
 * are named by a placeholder here rather than attached.
 */
function formatMcpResult(result: CallToolResult): string {
	const parts = toLlmContent(result).map((item) =>
		item.type === 'text' ? item.text : `[Image: ${item.mimeType}, ${item.data.length} base64 chars]`,
	);
	return parts.filter(Boolean).join('\n\n') || '(MCP tool returned no content)';
}
