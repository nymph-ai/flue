/**
 * MCP client: `@modelcontextprotocol/client` over Streamable HTTP
 * (docs/cloudflare-native.md rule 6), speaking the stateless 2026-07-28
 * protocol where the server does and the 2025 revisions where it does not.
 *
 * - `connect()` negotiates the SDK's way (`versionNegotiation: 'auto'`): it
 *   probes with `server/discover`, and a server that answers with anything
 *   but definitive 2026-07-28 evidence — `-32601 Method not found`, a 2025
 *   server's `Server not initialized` — gets the standard `initialize`
 *   handshake (2025-11-25 / 2025-06-18) and its session. Most servers today
 *   answer that way, Linear's among them.
 * - What each server speaks is kept in memory per link, for the instance's
 *   lifetime: a reconnect within it skips the probe (the SDK's `prior`
 *   verdict), and the 2025 session id lives in the transport. Nothing is
 *   written: a cold start negotiates again, one round trip.
 * - A 2025 server that forgot its session answers 404; the call
 *   re-initializes once and is sent again.
 * - Nothing standing is held open (rule 8): no `subscriptions/listen`, no
 *   `listChanged` handlers, and no 2025 GET stream (the transport's GET is
 *   answered 405 locally). Tool lists are refreshed when their cache hint
 *   (`ttlMs`) expires, or on the next wake when the server gave none.
 * - A connection keeps no state the protocol needs beyond that session: a
 *   fresh client after a Durable Object eviction works mid-conversation.
 * - `input_required` (multi-round-trip requests): a leg carrying only
 *   `requestState` is sent again with it; a leg with input requests is put
 *   to the question seam (`questions.ts`, rule 9), and its answer is sent
 *   back with the server's `requestState`. When the seam cannot answer, the
 *   call fails with {@link McpInputRequiredError}.
 */
import {
	type CallToolResult,
	Client,
	type PriorDiscovery,
	type FetchLike,
	isInputRequiredResult,
	SdkError,
	SdkErrorCode,
	StreamableHTTPClientTransport,
	type Tool,
	UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/client';
import { version as runtimeVersion } from '../package.json' with { type: 'json' };
import { fnv1a64 } from './fnv.ts';
import { createMcpAuthProvider } from './mcp-oauth.ts';
import type { McpConnectionDefinition } from './mcp-types.ts';
import {
	askQuestion,
	type FlueAnswer,
	type McpInputQuestion,
	QuestionParkedError,
} from './questions.ts';
import {
	type McpCallResult,
	type McpToolSource,
	type PreparedToolContent,
	registerMcpToolSource,
	registerPreparedToolAdapter,
} from './tool-adapter.ts';
import type { ToolDefinition } from './types.ts';

export type {
	McpAuth,
	McpConnectionDefinition,
	McpOAuth,
	McpToolAnnotations,
	McpTransport,
} from './mcp-types.ts';

/** The stateless MCP protocol revision Flue probes for first. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** The per-request timeout Flue documents for `timeoutMs`. */
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;

/** Model tool names are limited to 64 characters by several providers. */
const MAX_TOOL_NAME_LENGTH = 64;

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
 * A server answered a call with `input_required` (an elicitation, a sampling
 * request or the roots list) and the question seam could not get an answer;
 * `reason` says why (by default, that questions are not wired yet).
 */
export class McpInputRequiredError extends Error {
	override readonly name = 'McpInputRequiredError';
	constructor(
		readonly server: string,
		readonly method: string,
		readonly inputRequests: Readonly<Record<string, unknown>>,
		readonly reason?: string,
	) {
		super(
			[describeInputRequests(server, method, inputRequests), ...(reason ? [reason] : [])].join(
				'\n',
			),
		);
	}
}

/**
 * A server speaks no MCP revision Flue does. `offered` lists the versions it
 * named, when it named any; `answer` describes its `server/discover` answer
 * otherwise.
 */
export class McpProtocolVersionError extends Error {
	override readonly name = 'McpProtocolVersionError';
	constructor(
		readonly server: string,
		readonly url: string,
		readonly offered: readonly string[] | undefined,
		readonly answer: string | undefined,
	) {
		super(
			`[flue] MCP server "${server}" (${url}) speaks no MCP protocol revision Flue supports (${MCP_PROTOCOL_VERSION}, 2025-11-25, 2025-06-18). ` +
				(offered && offered.length > 0
					? `It offered: ${offered.join(', ')}.`
					: `Its server/discover answer: ${answer ?? 'none'}.`),
		);
	}
}

function describeInputRequests(
	server: string,
	method: string,
	inputRequests: Readonly<Record<string, unknown>>,
): string {
	const lines = Object.entries(inputRequests).map(([key, raw]) => {
		const request = (raw ?? {}) as { method?: unknown; params?: Record<string, unknown> };
		const params = request.params ?? {};
		const kind = typeof request.method === 'string' ? request.method : 'unknown request';
		const parts = [`- "${key}" (${kind})`];
		if (typeof params.message === 'string') parts.push(`: ${params.message}`);
		const schema = params.requestedSchema as { properties?: Record<string, unknown> } | undefined;
		const fields = schema?.properties ? Object.keys(schema.properties) : [];
		if (fields.length > 0) parts.push(` — fields: ${fields.join(', ')}`);
		if (typeof params.url === 'string') parts.push(` — open ${params.url}`);
		return parts.join('');
	});
	return [
		`[flue] MCP server "${server}" answered ${method} with input_required, and no answer could be obtained.`,
		...(lines.length > 0
			? ['Requested inputs:', ...lines]
			: ['The server sent no input requests, only request state.']),
	].join('\n');
}

const MAX_INPUT_ROUNDS = 10;
const STATE_ONLY_PACING_MS = 250;

/**
 * The SDK client, negotiating 2026-07-28 or the 2025 handshake, with Flue's
 * answer to `input_required`: questions go to the seam instead of the SDK's
 * auto-fulfilment through request handlers Flue never registers.
 */
class FlueMcpClient extends Client {
	constructor(private readonly serverName: string) {
		super(
			{ name: 'flue', version: runtimeVersion },
			{
				// server/discover first; the 2025 initialize handshake otherwise.
				versionNegotiation: { mode: 'auto' },
				capabilities: {},
			},
		);
	}

	protected override async _resolveNonCompleteResult(
		...[decoded, flow]: Parameters<Client['_resolveNonCompleteResult']>
	): Promise<unknown> {
		const params = (flow.request.params ?? {}) as Record<string, unknown>;
		const signal = flow.options?.signal;
		let leg: { inputRequests?: Record<string, unknown>; requestState?: string } = decoded;
		for (let round = 1; ; round++) {
			if (round > MAX_INPUT_ROUNDS) {
				throw new Error(
					`[flue] MCP server "${this.serverName}" kept answering ${flow.request.method} with input_required after ${MAX_INPUT_ROUNDS} rounds.`,
				);
			}
			const inputRequests = leg.inputRequests ?? {};
			let inputResponses: Readonly<Record<string, unknown>> | undefined;
			if (Object.keys(inputRequests).length === 0) {
				// Only requestState: the server asks to be called again with it.
				await new Promise((resolve) => setTimeout(resolve, STATE_ONLY_PACING_MS));
			} else {
				const question = mcpInputQuestion(
					this.serverName,
					flow.request.method,
					params,
					inputRequests,
					leg.requestState,
				);
				try {
					const answer = await askQuestion(question, signal);
					inputResponses = answer.kind === 'mcp-input' ? answer.inputResponses : undefined;
				} catch (error) {
					if (error instanceof QuestionParkedError) throw error;
					throw new McpInputRequiredError(
						this.serverName,
						flow.request.method,
						inputRequests,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
			const result = await flow.retry(
				{
					...params,
					...(inputResponses ? { inputResponses } : {}),
					...(leg.requestState !== undefined ? { requestState: leg.requestState } : {}),
				},
				{
					...(flow.options?.timeout !== undefined ? { timeout: flow.options.timeout } : {}),
					...(signal ? { signal } : {}),
					allowInputRequired: true,
				},
			);
			if (!isInputRequiredResult(result)) return result;
			leg = result;
		}
	}
}

function mcpInputQuestion(
	server: string,
	method: string,
	params: Record<string, unknown>,
	inputRequests: Record<string, unknown>,
	requestState: string | undefined,
): McpInputQuestion {
	const { inputResponses: _responses, requestState: _state, ...original } = params;
	return {
		kind: 'mcp-input',
		id: `mcp:${server}:${fnv1a64(JSON.stringify([method, original, requestState ?? null]))}`,
		server,
		method,
		params: original,
		inputRequests,
		...(requestState !== undefined ? { requestState } : {}),
	};
}

/** One live server: a client that can be rebuilt at any time, and its tool listing. */
class McpServerLink {
	#client: Promise<FlueMcpClient> | undefined;
	/** What the server speaks, once a connect learned it; in memory only. */
	#prior: PriorDiscovery | undefined;
	#listing: { tools: Tool[]; instructions?: string; expiresAt: number } | undefined;
	#closed = false;

	constructor(readonly definition: McpConnectionDefinition) {}

	get #requestOptions() {
		return {
			timeout: this.definition.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
			...(this.definition.resetTimeoutOnProgress
				? { resetTimeoutOnProgress: true, onprogress: () => {} }
				: {}),
		};
	}

	#connect(): Promise<FlueMcpClient> {
		if (this.#closed)
			return Promise.reject(
				new Error(`[flue] MCP connection "${this.definition.name}" is closed.`),
			);
		if (!this.#client) {
			const pending = (async () => {
				const client = new FlueMcpClient(this.definition.name);
				const probe: DiscoverProbe = {};
				const transport = createTransport(this.definition, probe);
				try {
					await client.connect(transport, {
						timeout: this.#requestOptions.timeout,
						...(this.#prior ? { prior: this.#prior } : {}),
					});
				} catch (error) {
					await client.close().catch(() => undefined);
					throw await refusedProtocol(this.definition, error, probe);
				}
				const discover = client.getDiscoverResult();
				this.#prior =
					client.getProtocolEra() === 'modern' && discover
						? { kind: 'modern', discover }
						: { kind: 'legacy' };
				return client;
			})();
			this.#client = pending;
			pending.catch(() => {
				if (this.#client === pending) this.#client = undefined;
			});
		}
		return this.#client;
	}

	/**
	 * The server's tools, refreshed when the listing's cache hint expired.
	 * Without a hint the listing holds for this link's lifetime — one wake on
	 * Cloudflare, where links are rebuilt after every eviction.
	 */
	async listing(): Promise<{ tools: Tool[]; instructions?: string }> {
		if (this.#listing && Date.now() < this.#listing.expiresAt) return this.#listing;
		let client: FlueMcpClient | undefined;
		const result = await this.#inSession(async (connected) => {
			client = connected;
			return connected.listTools(undefined, { ...this.#requestOptions, cacheMode: 'refresh' });
		});
		const ttlMs = (result as { ttlMs?: unknown }).ttlMs;
		const instructions = client?.getInstructions();
		this.#listing = {
			tools: result.tools,
			...(instructions ? { instructions } : {}),
			expiresAt:
				typeof ttlMs === 'number' && Number.isFinite(ttlMs)
					? Date.now() + Math.max(ttlMs, 1_000)
					: Number.POSITIVE_INFINITY,
		};
		return this.#listing;
	}

	async call(
		tool: Tool,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		return (await this.#inSession((client) =>
			client.callTool(
				{ name: tool.name, arguments: args },
				{ ...this.#requestOptions, toolDefinition: tool, ...(signal ? { signal } : {}) },
			),
		)) as CallToolResult;
	}

	/**
	 * Run `request` on the connected client. A 2025 server that answers 404
	 * has forgotten the session: connect again (a new `initialize`, no probe)
	 * and send the request once more.
	 */
	async #inSession<T>(request: (client: FlueMcpClient) => Promise<T>): Promise<T> {
		const client = await this.#connect();
		try {
			return await request(client);
		} catch (error) {
			if (this.#prior?.kind !== 'legacy' || !isSessionLost(error)) throw error;
			if (this.#client) {
				const stale = this.#client;
				this.#client = undefined;
				await stale.then((old) => old.close()).catch(() => undefined);
			}
			return request(await this.#connect());
		}
	}

	/**
	 * Continue a `tools/call` parked on `question` (Pi reran the call after an
	 * eviction, `pi/questions.ts`): get the answer from the seam, then send the
	 * original request again on a fresh request id with `inputResponses` and
	 * the server's `requestState`, byte for byte. A further `input_required`
	 * is asked like any other.
	 */
	async resume(
		tool: Tool,
		question: McpInputQuestion,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		let answer: FlueAnswer;
		try {
			answer = await askQuestion(question, signal);
		} catch (error) {
			if (error instanceof QuestionParkedError) throw error;
			throw new McpInputRequiredError(
				this.definition.name,
				question.method,
				question.inputRequests,
				error instanceof Error ? error.message : String(error),
			);
		}
		const params = {
			...(question.params as Record<string, unknown>),
			...(answer.kind === 'mcp-input' ? { inputResponses: answer.inputResponses } : {}),
			...(question.requestState !== undefined ? { requestState: question.requestState } : {}),
		};
		return (await this.#inSession((client) =>
			client.callTool(params as never, {
				...this.#requestOptions,
				toolDefinition: tool,
				...(signal ? { signal } : {}),
			}),
		)) as CallToolResult;
	}

	async close(): Promise<void> {
		this.#closed = true;
		const stale = this.#client;
		this.#client = undefined;
		await stale?.then((client) => client.close()).catch(() => undefined);
	}
}

/** A 2025 server's answer to a request on a session it no longer has: HTTP 404. */
function isSessionLost(error: unknown): boolean {
	return (
		SdkError.isInstance(error) && (error as { data?: { status?: unknown } }).data?.status === 404
	);
}

/** The `server/discover` answer a connect saw, kept for the refusal message. */
interface DiscoverProbe {
	answer?: Promise<string>;
}

/**
 * A connect that failed because the server offers no revision Flue speaks
 * becomes one {@link McpProtocolVersionError}; any other failure (network,
 * authorization, timeout) passes through unchanged.
 */
async function refusedProtocol(
	definition: McpConnectionDefinition,
	error: unknown,
	probe: DiscoverProbe,
): Promise<unknown> {
	const url = String(definition.url);
	if (UnsupportedProtocolVersionError.isInstance(error)) {
		return new McpProtocolVersionError(definition.name, url, [...error.supported], undefined);
	}
	if (
		SdkError.isInstance(error) &&
		error.code === SdkErrorCode.EraNegotiationFailed &&
		/offer(?:ed)? pinned protocol version/.test(error.message)
	) {
		const answer = probe.answer ? await probe.answer.catch(() => undefined) : undefined;
		return new McpProtocolVersionError(definition.name, url, undefined, answer ?? error.message);
	}
	return error;
}

/**
 * A per-instance MCP connection cache: the first declaration of a server
 * name connects; later submissions reuse the link for the instance's
 * in-memory lifetime and re-read its tool listing only when the listing's
 * cache hint expired. Concurrent resolves of one name share one link. A
 * failed resolve is evicted immediately — a transient outage must not brick
 * the instance, so the next submission retries with a freshly read
 * definition.
 */
export function createMcpConnectionCache(): McpConnectionCache {
	const links = new Map<string, McpServerLink>();
	const adapted = new WeakMap<McpServerLink, { key: string; tools: ToolDefinition[] }>();
	return {
		async resolve(definition: McpConnectionDefinition): Promise<McpConnection> {
			let link = links.get(definition.name);
			if (!link) {
				link = new McpServerLink(definition);
				links.set(definition.name, link);
			}
			const current = link;
			try {
				const listing = await current.listing();
				const key = fingerprint(listing.tools, current.definition.tools);
				let entry = adapted.get(current);
				if (entry?.key !== key) {
					entry = { key, tools: adaptServerTools(current, listing) };
					adapted.set(current, entry);
				}
				return { name: definition.name, tools: entry.tools, close: () => current.close() };
			} catch (error) {
				if (links.get(definition.name) === current) links.delete(definition.name);
				await current.close();
				throw error;
			}
		},
		async close(): Promise<void> {
			const all = [...links.values()];
			links.clear();
			await Promise.allSettled(all.map((link) => link.close()));
		},
	};
}

function fingerprint(tools: readonly Tool[], allowlist: readonly string[] | undefined): string {
	return fnv1a64(JSON.stringify([tools, allowlist ?? null]));
}

/**
 * Connects to an MCP server described by a {@link McpConnectionDefinition}
 * and adapts its listed tools into ordinary Flue tool definitions.
 *
 * Adapted tool names are `mcp__<server>__<tool>`. When a name had to change
 * to fit (unsupported characters, a `__` inside a part, more than 64
 * characters), it gains a stable `__<hash>` suffix of the original pair, so
 * two different tools never share a name. Close the returned connection when
 * its tools are no longer needed.
 */
export async function createMcpConnection(
	definition: McpConnectionDefinition,
): Promise<McpConnection> {
	const link = new McpServerLink(definition);
	try {
		const listing = await link.listing();
		return {
			name: definition.name,
			tools: adaptServerTools(link, listing),
			close: () => link.close(),
		};
	} catch (error) {
		await link.close();
		throw error;
	}
}

function createTransport(
	definition: McpConnectionDefinition,
	probe: DiscoverProbe,
): StreamableHTTPClientTransport {
	if (definition.transport === 'sse') {
		throw new Error(
			`[flue] MCP server "${definition.name}" is declared with transport 'sse' (the legacy HTTP+SSE transport), which Flue does not support: it needs a standing stream, and an agent holds no connection open between wakes. ` +
				"Point `url` at the server's Streamable HTTP endpoint and drop `transport: 'sse'`.",
		);
	}
	const url = definition.url instanceof URL ? definition.url : new URL(definition.url);
	return new StreamableHTTPClientTransport(url, {
		requestInit: mergeRequestInit(definition.requestInit, definition.headers),
		fetch: noStandingStream(recordingDiscover(definition.fetch, probe)),
		...(definition.auth === undefined
			? {}
			: {
					authProvider: createMcpAuthProvider(
						definition.name,
						url,
						definition.auth,
						definition.fetch,
					),
				}),
		// A step-up needs a user at a browser; surface it as an error instead.
		onInsufficientScope: 'throw',
	});
}

/**
 * The 2025 transport opens a GET stream for server-initiated messages after
 * `initialize`. An agent holds nothing open (rule 8) and asks for nothing
 * the server could push, so that GET is answered here as a server without
 * one would: 405.
 */
function noStandingStream(base: FetchLike): FetchLike {
	return async (input, init) => {
		const method = (init?.method ?? 'GET').toUpperCase();
		if (method === 'GET')
			return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
		return base(input, init);
	};
}

/**
 * Keep a description of the answer to `server/discover`, so a server that
 * speaks no revision Flue does is refused with what it actually said.
 */
function recordingDiscover(base: typeof fetch | undefined, probe: DiscoverProbe): FetchLike {
	return async (input, init) => {
		const response = await (base ?? fetch)(input, init);
		if (typeof init?.body === 'string' && init.body.includes('"server/discover"')) {
			probe.answer = describeDiscoverAnswer(response.clone());
		}
		return response;
	};
}

async function describeDiscoverAnswer(response: Response): Promise<string> {
	const text = (await response.text()).trim();
	const json =
		text
			.split('\n')
			.find((line) => line.startsWith('data:'))
			?.slice(5)
			.trim() ?? text;
	try {
		const message = JSON.parse(json) as {
			result?: { supportedVersions?: unknown };
			error?: { code?: unknown; message?: unknown; data?: { supported?: unknown } };
		};
		const versions = message.result?.supportedVersions;
		if (Array.isArray(versions)) {
			return `HTTP ${response.status}, supportedVersions ${versions.join(', ')}`;
		}
		if (message.error) {
			const supported = message.error.data?.supported;
			return `HTTP ${response.status}, JSON-RPC error ${String(message.error.code)} ${JSON.stringify(message.error.message ?? '')}${Array.isArray(supported) ? `, supported ${supported.join(', ')}` : ''}`;
		}
	} catch {
		// Not JSON: describe the raw answer below.
	}
	return `HTTP ${response.status}${text ? ` ${JSON.stringify(text.slice(0, 200))}` : ''}`;
}

function mergeRequestInit(
	requestInit: RequestInit | undefined,
	headers: HeadersInit | undefined,
): RequestInit {
	if (!headers) return requestInit ?? {};
	const mergedHeaders = new Headers(requestInit?.headers);
	for (const [key, value] of new Headers(headers)) mergedHeaders.set(key, value);
	return { ...requestInit, headers: mergedHeaders };
}

/**
 * Apply the `tools` allowlist to the discovered listing, in allowlist order.
 * Every allowlisted name must exist and be callable — a typo or an
 * unsupported tool must fail loud, not silently narrow the tool set.
 */
function selectMcpTools(
	serverName: string,
	discovered: readonly Tool[],
	allowlist: readonly string[] | undefined,
): Tool[] {
	if (allowlist === undefined) {
		return discovered.filter((tool) => {
			if (tool.execution?.taskSupport !== 'required') return true;
			console.warn(
				`[flue] Skipping MCP tool "${tool.name}" from server "${serverName}": it requires task-based execution, which is not supported.`,
			);
			return false;
		});
	}
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

function adaptServerTools(
	link: McpServerLink,
	listing: { tools: Tool[]; instructions?: string },
): ToolDefinition[] {
	const serverName = link.definition.name;
	const tools = selectMcpTools(serverName, listing.tools, link.definition.tools);
	const names = new Set<string>();
	return tools.map((tool) => {
		const toolName = mcpToolName(serverName, tool.name);
		if (names.has(toolName)) {
			// Only a server listing one name twice gets here: distinct names
			// map to distinct adapted names.
			throw new Error(
				`[flue] MCP server "${serverName}" lists the tool "${tool.name}" more than once.`,
			);
		}
		names.add(toolName);

		const definition: ToolDefinition = {
			name: toolName,
			description: createToolDescription(serverName, tool, toolName),
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
		const call = async (args: Record<string, unknown>, signal?: AbortSignal) => {
			if (signal?.aborted) throw new Error('Operation aborted');
			return (await link.call(tool, args, signal)) as McpCallResult;
		};
		registerPreparedToolAdapter(definition, {
			parameters: normalizeInputSchema(tool.inputSchema),
			async execute(args, signal) {
				return mcpToolOutput(tool.name, await call(args, signal));
			},
		});
		const source: McpToolSource = {
			server: serverName,
			...(listing.instructions ? { instructions: listing.instructions } : {}),
			tool: {
				name: tool.name,
				...(tool.title ? { title: tool.title } : {}),
				...(tool.description ? { description: tool.description } : {}),
				inputSchema: normalizeInputSchema(tool.inputSchema),
				...(tool.outputSchema ? { outputSchema: tool.outputSchema as object } : {}),
				...(tool.annotations ? { annotations: Object.freeze({ ...tool.annotations }) } : {}),
			},
			call,
			async resume(question, signal) {
				if (signal?.aborted) throw new Error('Operation aborted');
				return (await link.resume(tool, question, signal)) as McpCallResult;
			},
		};
		registerMcpToolSource(definition, source);
		return Object.freeze(definition);
	});
}

/** What the model sees of an MCP tool result; an error result throws its text. */
export function mcpToolOutput(toolName: string, result: McpCallResult): PreparedToolContent[] {
	const content = toModelContent(result);
	if (result.isError) {
		throw new Error(
			content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n') ||
				`MCP tool "${toolName}" failed.`,
		);
	}
	return content;
}

const SAFE_PART = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

function cleanPart(value: string): string {
	return (
		value
			.replace(/[^A-Za-z0-9_-]/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '') || 'unnamed'
	);
}

/**
 * The model-facing name of a server's tool. `mcp__<server>__<tool>` when both
 * parts are already safe (letters, digits, `-`, single inner `_`): such names
 * are injective, since neither part can contain the `__` separator. Anything
 * else — an unsupported character, `__` inside a part, a leading or trailing
 * `_`, a name over 64 characters — gets the cleaned parts plus a
 * `__<hash>` suffix of the original pair. Names with a suffix have three
 * separators and plain names two, so the two classes never meet, and `-`
 * and `_` stay distinct (`get-user` and `get_user` are different tools).
 */
export function mcpToolName(serverName: string, toolName: string): string {
	const plain = `mcp__${serverName}__${toolName}`;
	if (
		SAFE_PART.test(serverName) &&
		SAFE_PART.test(toolName) &&
		plain.length <= MAX_TOOL_NAME_LENGTH
	) {
		return plain;
	}
	const hash = fnv1a64(JSON.stringify([serverName, toolName])).slice(0, 8);
	const server = cleanPart(serverName).slice(0, 20).replace(/_$/, '');
	const room = MAX_TOOL_NAME_LENGTH - `mcp__${server}____${hash}`.length;
	const tool = cleanPart(toolName).slice(0, Math.max(room, 1)).replace(/_$/, '');
	return `mcp__${server}__${tool}__${hash}`;
}

function createToolDescription(serverName: string, tool: Tool, adaptedName: string): string {
	const parts: string[] = [];
	// Spell out the original names only when the adapted name does not read
	// them back, so server descriptions that cross-reference sibling tools by
	// their original names stay followable.
	if (adaptedName !== `mcp__${serverName}__${tool.name}`) {
		parts.push(`MCP tool "${tool.name}" from server "${serverName}".`);
	}
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
		...(schema.required ? { required: schema.required } : {}),
	};
}

/**
 * The model-facing content of a tool result: text passes through, images
 * stay images, embedded text resources are unwrapped and embedded image
 * resources become images; audio, links and binary resources become short
 * text placeholders. A result without content blocks but with
 * `structuredContent` becomes its JSON (servers should, but do not always,
 * mirror structured results as text).
 */
export function toModelContent(result: McpCallResult): PreparedToolContent[] {
	const content: PreparedToolContent[] = [];
	for (const block of result.content ?? []) {
		const item = block as Record<string, unknown> & { type: string };
		switch (item.type) {
			case 'text':
				content.push({ type: 'text', text: String(item.text ?? '') });
				break;
			case 'image':
				content.push({ type: 'image', data: String(item.data), mimeType: String(item.mimeType) });
				break;
			case 'audio':
				content.push({ type: 'text', text: `[Audio: ${String(item.mimeType)} omitted]` });
				break;
			case 'resource_link':
				content.push({
					type: 'text',
					text: `[Resource link: ${String(item.name)} (${String(item.uri)})]`,
				});
				break;
			case 'resource': {
				const resource = (item.resource ?? {}) as Record<string, unknown>;
				if (typeof resource.text === 'string') {
					content.push({ type: 'text', text: resource.text });
				} else if (
					typeof resource.mimeType === 'string' &&
					resource.mimeType.startsWith('image/')
				) {
					content.push({ type: 'image', data: String(resource.blob), mimeType: resource.mimeType });
				} else {
					content.push({
						type: 'text',
						text: `[Binary resource ${String(resource.uri)} (${String(resource.mimeType ?? 'unknown type')}) omitted]`,
					});
				}
				break;
			}
			default:
				content.push({ type: 'text', text: JSON.stringify(item) });
		}
	}
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) });
	}
	if (content.length === 0) content.push({ type: 'text', text: '(MCP tool returned no content)' });
	return content;
}
