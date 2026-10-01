/**
 * MCP client: `@modelcontextprotocol/client` over Streamable HTTP, speaking
 * the stateless 2026-07-28 protocol and nothing else
 * (docs/cloudflare-native.md rule 6).
 *
 * - `connect()` probes with `server/discover`, pinned to 2026-07-28: there is
 *   no fallback to the 2025 `initialize` handshake, so there are no sessions.
 *   A server that does not offer 2026-07-28 is refused with
 *   {@link McpProtocolVersionError}, naming the versions it offered or its
 *   `server/discover` answer.
 * - Nothing standing is held open (rule 8): no `subscriptions/listen` and no
 *   `listChanged` handlers. Tool lists are refreshed when their cache hint
 *   (`ttlMs`) expires, or on the next wake when the server gave none.
 * - A connection keeps no state the protocol needs: a fresh client after a
 *   Durable Object eviction works mid-conversation.
 * - `input_required` (multi-round-trip requests): a leg carrying only
 *   `requestState` is sent again with it; a leg with input requests is put
 *   to the question seam (`questions.ts`, rule 9), and its answer is sent
 *   back with the server's `requestState`. When the seam cannot answer, the
 *   call fails with {@link McpInputRequiredError}.
 */
import {
	type CallToolResult,
	Client,
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
import { askQuestion, type McpInputQuestion, QuestionParkedError } from './questions.ts';
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

/** The one MCP protocol revision Flue speaks. */
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
 * A server does not speak MCP 2026-07-28, the only revision Flue supports.
 * `offered` lists the versions it named, when it named any; `answer`
 * describes its `server/discover` answer otherwise.
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
			`[flue] MCP server "${server}" (${url}) does not speak MCP ${MCP_PROTOCOL_VERSION}, the only protocol revision Flue supports; servers on earlier revisions are not supported. ` +
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
 * The SDK client pinned to 2026-07-28, with Flue's answer to
 * `input_required`: questions go to the seam instead of the SDK's
 * auto-fulfilment through request handlers Flue never registers.
 */
class FlueMcpClient extends Client {
	constructor(private readonly serverName: string) {
		super(
			{ name: 'flue', version: runtimeVersion },
			{
				// server/discover only: no fallback to the 2025 initialize handshake.
				versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
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
					await client.connect(transport, { timeout: this.#requestOptions.timeout });
				} catch (error) {
					await client.close().catch(() => undefined);
					throw await refusedProtocol(this.definition, error, probe);
				}
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
		const client = await this.#connect();
		const result = await client.listTools(undefined, {
			...this.#requestOptions,
			cacheMode: 'refresh',
		});
		const ttlMs = (result as { ttlMs?: unknown }).ttlMs;
		const instructions = client.getInstructions();
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
		const client = await this.#connect();
		return (await client.callTool(
			{ name: tool.name, arguments: args },
			{ ...this.#requestOptions, toolDefinition: tool, ...(signal ? { signal } : {}) },
		)) as CallToolResult;
	}

	async close(): Promise<void> {
		this.#closed = true;
		const stale = this.#client;
		this.#client = undefined;
		await stale?.then((client) => client.close()).catch(() => undefined);
	}
}

/** The `server/discover` answer a connect saw, kept for the refusal message. */
interface DiscoverProbe {
	answer?: Promise<string>;
}

/**
 * A connect that failed because the server does not offer 2026-07-28
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
		fetch: recordingDiscover(definition.fetch, probe),
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
 * Keep a description of the answer to `server/discover`, so a server that
 * does not speak 2026-07-28 is refused with what it actually said.
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
				const result = await call(args, signal);
				const content = toModelContent(result);
				if (result.isError) {
					throw new Error(
						content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n') ||
							`MCP tool "${tool.name}" failed.`,
					);
				}
				return content;
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
		};
		registerMcpToolSource(definition, source);
		return Object.freeze(definition);
	});
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
