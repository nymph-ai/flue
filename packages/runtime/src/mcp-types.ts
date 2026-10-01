/**
 * MCP definition shapes, dependency-free so both `types.ts` (render config)
 * and `mcp.ts` (the connector) can import them.
 */

/**
 * MCP transport. `'streamable-http'` (the default) speaks the stateless
 * 2026-07-28 protocol and negotiates down to servers on earlier revisions.
 * `'stdio'` runs a local server process and exists only on the Node target.
 * `'sse'` (the legacy HTTP+SSE transport) is refused: it needs a standing
 * stream, which an agent that hibernates between wakes cannot hold.
 */
export type McpTransport = 'streamable-http' | 'stdio' | 'sse';

/**
 * Tool annotations from an MCP server's `tools/list` entry. The MCP adapter
 * carries them through to the adapted tool definition's `annotations` field
 * so application code can inspect the server's hints — e.g. when gating calls
 * on human approval. They are untrusted unless the server is trusted; the
 * runtime does not change execution based on them. `title` is also read by
 * the adapted tool description.
 */
export interface McpToolAnnotations {
	/** Tool title, when the server declares one. */
	title?: string;
	/** The server hints that the tool does not change server state. */
	readOnlyHint?: boolean;
	/** The server hints that the tool may perform destructive updates. */
	destructiveHint?: boolean;
	/** The server hints that repeated calls with identical arguments are idempotent. */
	idempotentHint?: boolean;
	/** The server hints that the tool may interact with an open world. */
	openWorldHint?: boolean;
}

/**
 * OAuth for an MCP server (the MCP 2026-07-28 authorization rules): the
 * runtime discovers the server's authorization server, registers a client
 * (a Client ID Metadata Document when the server supports one, dynamic
 * registration otherwise), runs the authorization-code flow with PKCE, binds
 * every stored credential to the authorization server's issuer, and
 * refreshes tokens one at a time. Credentials live in Flue's OAuth store — on
 * Cloudflare the `FlueMcpAuth` Durable Object, one per principal and
 * authorization server; on Node an in-memory store unless one is configured.
 * Build it with `mcpOAuth(...)`.
 */
export interface McpOAuth {
	readonly type: 'oauth';
	/**
	 * Whose credentials these are: a stable identifier of the user or
	 * service the agent acts for. Tokens are never shared across principals.
	 */
	readonly principal: string;
	/**
	 * Absolute URL of the OAuth callback route Flue serves,
	 * `https://<your app>/__flue/mcp/oauth/callback`.
	 */
	readonly redirectUrl: string;
	/** Scope to request. Default: the scopes the server's metadata advertises. */
	readonly scope?: string;
	/**
	 * HTTPS URL of a Client ID Metadata Document describing this client.
	 * Used as the `client_id` when the authorization server supports Client
	 * ID Metadata Documents; otherwise the client registers dynamically.
	 */
	readonly clientMetadataUrl?: string;
	/** `client_name` for dynamic registration. Default `"Flue"`. */
	readonly clientName?: string;
}

/**
 * Credential for an MCP server: a static bearer token, a resolver the
 * runtime calls to obtain the current bearer token — per request, so
 * rotating and per-user credentials stay fresh for a connection's whole
 * lifetime — or OAuth ({@link McpOAuth}). Keep the durable key (say, a user
 * id) in a resolver's closure and fetch the token inside it; bearer tokens
 * are never persisted.
 */
export type McpAuth = string | (() => string | Promise<string>) | McpOAuth;

/** Fields every MCP connection definition shares. */
interface McpConnectionDefinitionBase {
	/** Server name — the `mcp__<server>__` namespace of its adapted tools. */
	name: string;
	/** Per-request timeout in milliseconds for MCP requests. Defaults to 60 seconds. */
	timeoutMs?: number;
	/** Reset the per-request timeout whenever the server sends a progress notification. Defaults to `false`. */
	resetTimeoutOnProgress?: boolean;
	/**
	 * Allowlist of tools to adapt, by the server's own tool names, in this
	 * order. Names the server does not expose are an error — a typo must fail
	 * loud, not silently narrow the tool set. Omit to adapt every listed tool.
	 */
	tools?: string[];
	/**
	 * Let the agent run without this server when it fails to resolve.
	 * Default `false`: a failed connection fails the submission before the
	 * model runs. With `optional: true`, the failure mounts zero tools for
	 * the submission instead — announced to the model as a `resources`
	 * signal and to observers as a warning event — and the next submission
	 * retries.
	 */
	optional?: boolean;
}

/** A remote MCP server, over Streamable HTTP. */
export interface McpHttpConnectionDefinition extends McpConnectionDefinitionBase {
	/** MCP server endpoint. */
	url: string | URL;
	/** Defaults to `'streamable-http'`. */
	transport?: 'streamable-http' | 'sse';
	/** Credential sent with every request; see {@link McpAuth}. */
	auth?: McpAuth;
	/**
	 * Static headers merged into MCP transport requests (set-wins over
	 * `requestInit` headers). For credentials, prefer `auth`.
	 */
	headers?: HeadersInit;
	/** Additional MCP transport request configuration. */
	requestInit?: RequestInit;
	/** Custom fetch implementation used by the MCP transport. */
	fetch?: typeof fetch;
}

/**
 * A local MCP server process spoken to over stdio. Node target only: a
 * Cloudflare Worker cannot start processes, and the stdio transport is never
 * bundled into a Worker.
 */
export interface McpStdioConnectionDefinition extends McpConnectionDefinitionBase {
	transport: 'stdio';
	/** Executable to run. */
	command: string;
	/** Command-line arguments. */
	args?: string[];
	/** Environment for the process. Default: a minimal inherited environment. */
	env?: Record<string, string>;
	/** Working directory for the process. */
	cwd?: string;
}

/**
 * One MCP server, as `defineMcpConnection(...)`, `useMcpConnection(...)`, and
 * `createMcpConnection(...)` consume it.
 */
export type McpConnectionDefinition = McpHttpConnectionDefinition | McpStdioConnectionDefinition;

/**
 * One optional MCP connection that failed to resolve at submission
 * initialization: the server contributed no tools, and the session announces
 * the gap to the model.
 */
export interface McpUnavailableConnection {
	/** Declared server name. */
	name: string;
	/** Failure description, from the connect or discovery error. */
	reason: string;
}

/** Whether a definition runs a local process over stdio. */
export function isStdioDefinition(
	definition: McpConnectionDefinition,
): definition is McpStdioConnectionDefinition {
	return definition.transport === 'stdio';
}

/** Whether an `auth` value is an {@link McpOAuth} declaration. */
export function isMcpOAuth(auth: McpAuth | undefined): auth is McpOAuth {
	return typeof auth === 'object' && auth !== null && (auth as McpOAuth).type === 'oauth';
}
