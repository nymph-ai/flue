/**
 * The `codemode` tool: one Pi Durable `ToolRegistration` that runs a
 * model-written script through an `@cloudflare/codemode` executor
 * (docs/cloudflare-native.md rule 7) — a Dynamic Worker with no network on
 * Cloudflare, a `node:vm` worker thread on Node.
 *
 * The script reaches the world only through the namespaces this tool hands
 * the executor:
 *
 * - `codemode` — the platform: `search(query)` and `describe(path)` over the
 *   whole catalog, and `store(key, value)` / `load(key)`, values kept per
 *   conversation in a Pi document ({@link FlueCodemodeStore}).
 * - `tools` — the agent's own Flue tools (sandbox and `useTool()` tools).
 * - one namespace per MCP server, a `CodemodeConnector` whose methods return
 *   the server's typed `structuredContent` (or its content, images
 *   included).
 *
 * Pi replays the tool as `unsafe`: nested calls have effects, so an
 * interrupted script settles as interrupted and is never rerun.
 */
import type { JsonValue } from '@earendil-works/chord';
import type {
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from '@earendil-works/pi-durable';
import { toModelContent } from '../mcp.ts';
import { getMcpToolSource, type McpCallResult, type McpToolSource } from '../tool-adapter.ts';
import {
	type CatalogMethod,
	type CatalogNamespace,
	describeCatalog,
	loadCodemode,
	resolveNamespaces,
	searchCatalog,
} from './catalog.ts';
import type { CodemodeExecuteResult, CodemodeExecutor, CodemodeProvider } from './executor.ts';
import { namespaceIdentifiers, uniqueIdentifiers } from './identifiers.ts';
import { FlueCodemodeStore } from './store.ts';

export const CODEMODE_TOOL_NAME = 'codemode';

/** The namespace of the agent's own tools. */
export const AGENT_TOOLS_NAMESPACE = 'tools';

/** Default token budget for the script's output. */
export const DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS = 10_000;

const MAX_CODE_LENGTH = 1_000_000;
const MAX_STORE_VALUE_BYTES = 256 * 1024;

export interface CodemodeToolOptions {
	/** Runs the scripts: `@cloudflare/codemode`'s `Executor` contract. */
	readonly executor: CodemodeExecutor;
	/**
	 * Tools the script may call: the render's tools and MCP tools. An MCP
	 * tool joins its server's namespace; a tool named `codemode` is left out.
	 */
	readonly tools: readonly ToolRegistration[];
	/** Output budget, in tokens (≈4 characters each). Default 10 000. */
	readonly maxOutputTokens?: number;
}

/** Details recorded on the codemode tool result: the script's calls. */
export interface CodemodeToolDetails {
	readonly calls: { path: string; ok: boolean; durationMs: number }[];
}

interface Catalog {
	readonly namespaces: readonly CatalogNamespace[];
}

/** Group the offered tools into sandbox namespaces. */
function buildCatalog(
	tools: readonly ToolRegistration[],
	runFlueTool: (tool: ToolRegistration, input: unknown) => Promise<unknown>,
): Catalog {
	const own = tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME && !getMcpToolSource(tool));
	const servers = new Map<string, McpToolSource[]>();
	for (const tool of tools) {
		const source = getMcpToolSource(tool);
		if (!source) continue;
		const list = servers.get(source.server) ?? [];
		list.push(source);
		servers.set(source.server, list);
	}
	const namespaces: CatalogNamespace[] = [];
	if (own.length > 0) {
		const ids = uniqueIdentifiers(own.map((tool) => tool.name));
		namespaces.push({
			id: AGENT_TOOLS_NAMESPACE,
			kind: 'tools',
			title: 'agent tools',
			methods: own.map(
				(tool): CatalogMethod => ({
					id: ids.get(tool.name) as string,
					name: tool.name,
					description: tool.description,
					inputSchema: tool.parameters as object,
					execute: (input) => runFlueTool(tool, input),
				}),
			),
		});
	}
	const serverIds = namespaceIdentifiers([...servers.keys()], [AGENT_TOOLS_NAMESPACE]);
	for (const [server, sources] of servers) {
		const ids = uniqueIdentifiers(sources.map((source) => source.tool.name));
		const instructions = sources[0]?.instructions;
		namespaces.push({
			id: serverIds.get(server) as string,
			kind: 'mcp',
			title: server,
			...(instructions ? { instructions } : {}),
			methods: sources.map(
				(source): CatalogMethod => ({
					id: ids.get(source.tool.name) as string,
					name: source.tool.name,
					...(source.tool.description ? { description: source.tool.description } : {}),
					inputSchema: source.tool.inputSchema,
					...(source.tool.outputSchema ? { outputSchema: source.tool.outputSchema } : {}),
					execute: async (input) => unwrapMcpResult(source, await source.call(asArgs(input))),
				}),
			),
		});
	}
	return { namespaces };
}

function asArgs(input: unknown): Record<string, unknown> {
	return input !== null && typeof input === 'object' && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

/**
 * What an MCP method returns inside the script: the typed
 * `structuredContent` when the server sent it; text as a string (parsed when
 * it is JSON); otherwise `{ content }`, images and all. A tool error throws.
 */
function unwrapMcpResult(source: McpToolSource, result: McpCallResult): unknown {
	const blocks = result.content ?? [];
	const text = blocks
		.filter((block) => block.type === 'text')
		.map((block) => String(block.text ?? ''))
		.join('\n');
	if (result.isError) throw new Error(text || `MCP tool "${source.tool.name}" failed.`);
	if (result.structuredContent !== undefined && result.structuredContent !== null) {
		return result.structuredContent;
	}
	if (blocks.length > 0 && blocks.every((block) => block.type === 'text')) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return { content: blocks };
}

function namespaceLine(namespace: CatalogNamespace): string {
	if (namespace.kind === 'tools') {
		const names = namespace.methods.map((method) => method.id);
		const shown = names.slice(0, 40).join(', ');
		return `- \`${namespace.id}\` — this agent's own tools: ${shown}${names.length > 40 ? `, … (${names.length} in all)` : ''}`;
	}
	const instructions = namespace.instructions?.split('\n')[0]?.slice(0, 200);
	return `- \`${namespace.id}\` — MCP server "${namespace.title}", ${namespace.methods.length} method${namespace.methods.length === 1 ? '' : 's'}${instructions ? `. ${instructions}` : ''}`;
}

/** The model-facing description: the sandbox ABI and the namespaces, never the full catalog. */
export function createCodemodeDescription(catalog: Catalog): string {
	return [
		'Run JavaScript in an isolated sandbox to find and call methods and combine their results. Only what the script returns or logs comes back to you.',
		'',
		'Write an async arrow function, for example `async () => { const hits = await codemode.search("create issue"); return hits; }`. Plain JavaScript only — no TypeScript syntax.',
		'',
		'Globals:',
		'- `codemode.search(query)` — rank methods by intent: `{ results: [{ path, description }], total, truncated }`.',
		'- `codemode.describe(path)` — TypeScript declarations for a method (`"github.create_issue"`) or a whole namespace (`"github"`), output types included.',
		'- `codemode.store(key, value)` / `codemode.load(key)` — JSON values kept across codemode calls in this conversation. Writes are kept only when the script succeeds; storing `undefined` deletes.',
		'- `<namespace>.<method>(input)` — call a method with one object argument.',
		'',
		'Namespaces:',
		...(catalog.namespaces.length > 0 ? catalog.namespaces.map(namespaceLine) : ['- (none)']),
		'',
		'Rules:',
		'- Do not guess method names or argument shapes: search, then describe.',
		"- An MCP method returns the server's structured result when it declares an output type; text comes back as a string (parsed when it is JSON); anything else, images included, as `{ content: [...] }`. A failed call throws.",
		'- To show yourself an image, return content blocks: `return { content: [imageBlock] }` or an array of blocks.',
		'- No network, filesystem, Node APIs or timers: everything goes through the namespaces. Calls are real and have side effects; a failed script does not undo earlier calls.',
	].join('\n');
}

const PARAMETERS = {
	type: 'object',
	properties: {
		code: {
			type: 'string',
			description:
				'JavaScript source: an async arrow function, e.g. `async () => { ... return value; }`.',
		},
	},
	required: ['code'],
	additionalProperties: false,
} as const;

/** Is this value MCP-style content the model should see as content? */
function contentBlocks(
	value: unknown,
): readonly ({ type: string } & Record<string, unknown>)[] | undefined {
	const isBlock = (item: unknown) =>
		item !== null &&
		typeof item === 'object' &&
		typeof (item as { type?: unknown }).type === 'string' &&
		['text', 'image', 'audio', 'resource', 'resource_link'].includes(
			(item as { type: string }).type,
		);
	if (Array.isArray(value) && value.length > 0 && value.every(isBlock)) return value as never;
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		const content = (value as { content?: unknown }).content;
		if (Array.isArray(content) && content.length > 0 && content.every(isBlock))
			return content as never;
	}
	return undefined;
}

function serialize(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined) return '(no return value)';
	try {
		return (
			JSON.stringify(
				value,
				(_key, nested) => (typeof nested === 'bigint' ? nested.toString() : nested),
				2,
			) ?? String(value)
		);
	} catch (error) {
		return `(the result could not be serialized: ${error instanceof Error ? error.message : String(error)})`;
	}
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.7);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n… ${text.length - maxChars} characters truncated …\n${text.slice(-tail)}`;
}

type Content = NonNullable<ToolExecutionResult['content']>;

export function createCodemodeToolRegistration(options: CodemodeToolOptions): ToolRegistration {
	const offered = options.tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
	const describeOnly = buildCatalog(offered, async () => undefined);
	const maxChars = (options.maxOutputTokens ?? DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS) * 4;

	return {
		name: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription(describeOnly),
		parameters: PARAMETERS as unknown as ToolRegistration['parameters'],
		// Nested calls have side effects; an interrupted script is not rerun.
		replay: 'unsafe',
		async execute(args, api, context): Promise<ToolExecutionResult> {
			const code =
				args !== null && typeof args === 'object' && !Array.isArray(args)
					? (args as { code?: unknown }).code
					: undefined;
			if (typeof code !== 'string' || code.trim().length === 0) {
				return {
					content: [
						{ type: 'text', text: '`code` must be a non-empty string of JavaScript source.' },
					],
					isError: true,
				};
			}
			if (code.length > MAX_CODE_LENGTH) {
				return {
					content: [{ type: 'text', text: 'The script is too large (over 1 MB).' }],
					isError: true,
				};
			}
			const started = performance.now();
			const cm = await loadCodemode();

			let nested = 0;
			const runFlueTool = async (tool: ToolRegistration, input: unknown): Promise<unknown> => {
				const callId = `${api.callId}/${++nested}`;
				const chunks: string[] = [];
				const decoder = new TextDecoder();
				const nestedApi: ToolExecutionApi = {
					...api,
					callId,
					output: (chunk) => {
						chunks.push(
							typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }),
						);
					},
					diagnostic: () => {},
					details: async () => {},
				};
				const raw = (input ?? {}) as JsonValue;
				const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
				const result = await tool.execute(prepared, nestedApi, context);
				const blocks = result.content ?? [];
				const text =
					result.content === undefined
						? chunks.join('')
						: blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
				if (result.isError) throw new Error(text || `Tool "${tool.name}" failed.`);
				const output = (result.details as { output?: unknown } | undefined)?.output;
				if (output !== undefined) return output;
				if (blocks.some((block) => block.type === 'image')) return { content: blocks };
				try {
					return JSON.parse(text);
				} catch {
					return text;
				}
			};

			const catalog = buildCatalog(offered, runFlueTool);
			const calls: CodemodeToolDetails['calls'] = [];
			const observe = async (namespace: string, method: string, run: () => Promise<unknown>) => {
				const callStarted = performance.now();
				try {
					const value = await run();
					calls.push({
						path: `${namespace}.${method}`,
						ok: true,
						durationMs: Math.round(performance.now() - callStarted),
					});
					return value;
				} catch (error) {
					calls.push({
						path: `${namespace}.${method}`,
						ok: false,
						durationMs: Math.round(performance.now() - callStarted),
					});
					throw error;
				}
			};
			const resolved = await resolveNamespaces(cm, catalog.namespaces, observe);
			const descriptions = resolved.map((entry) => entry.description);

			const stored =
				(await api.snapshot(FlueCodemodeStore, api.conversationId, context))?.values ?? {};
			const writes = new Map<string, JsonValue | undefined>();
			const platform: CodemodeProvider = {
				name: 'codemode',
				fns: {
					search: async (query?: unknown) => searchCatalog(String(query ?? ''), descriptions),
					describe: async (target?: unknown) =>
						describeCatalog(cm, String(target ?? ''), descriptions),
					store: async (key?: unknown, value?: unknown) => {
						if (typeof key !== 'string' || key.length === 0)
							throw new Error('store(key, value): key must be a non-empty string.');
						if (value === undefined) {
							writes.set(key, undefined);
							return true;
						}
						const json = JSON.stringify(value);
						if (json === undefined)
							throw new Error('store(key, value): value must be JSON-serializable.');
						if (json.length > MAX_STORE_VALUE_BYTES)
							throw new Error('store(key, value): value is larger than 256 KiB.');
						writes.set(key, JSON.parse(json) as JsonValue);
						return true;
					},
					load: async (key?: unknown) => {
						if (typeof key !== 'string') return undefined;
						return writes.has(key) ? writes.get(key) : stored[key];
					},
				},
			};

			const signal = context.abortSignal;
			let outcome: CodemodeExecuteResult;
			try {
				outcome = await raceAbort(
					options.executor.execute(cm.normalizeCode(code), [
						platform,
						...resolved.map((entry) => entry.provider),
					]),
					signal,
				);
			} catch (error) {
				outcome = {
					result: undefined,
					error: error instanceof Error ? error.message : String(error),
				};
			}

			const wallTime = ((performance.now() - started) / 1000).toFixed(1);
			const logs = outcome.logs?.length
				? `\nConsole:\n${clip(outcome.logs.join('\n'), maxChars)}`
				: '';
			const details: CodemodeToolDetails = { calls };
			if (outcome.error !== undefined) {
				const made =
					calls.length > 0
						? `\nCalls made before the failure (not undone): ${calls.map((call) => call.path).join(', ')}`
						: '';
				return {
					content: [
						{ type: 'text', text: `Script failed (${wallTime}s): ${outcome.error}${made}${logs}` },
					],
					details: details as unknown as JsonValue,
					isError: true,
				};
			}

			if (writes.size > 0) {
				await api.commit(async (tx) => {
					const doc = await tx.doc(FlueCodemodeStore, api.conversationId);
					for (const [key, value] of writes) {
						if (value === undefined) delete doc.values[key];
						else doc.values[key] = value as never;
					}
				}, context);
			}

			const header: Content = [{ type: 'text', text: `Script completed (${wallTime}s).${logs}` }];
			const blocks = contentBlocks(outcome.result);
			const body: Content = blocks
				? toModelContent({ content: blocks }).map((block) =>
						block.type === 'text'
							? { type: 'text' as const, text: clip(block.text, maxChars) }
							: block,
					)
				: [{ type: 'text', text: clip(serialize(outcome.result), maxChars) }];
			return { content: [...header, ...body], details: details as unknown as JsonValue };
		},
	};
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(new Error('Script aborted.'));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error('Script aborted.'));
		signal.addEventListener('abort', onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}
