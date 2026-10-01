/**
 * The `codemode` tool as a Pi Durable `ToolRegistration`. It follows Pi's
 * own codemode tool (`pi-coding-agent/src/extensions/codemode/{tool,execute}.ts`
 * at 0.99.2) for everything the model sees — the description, the per-tool
 * declarations from `@earendil-works/pi-codemode/declarations`, the source
 * grammar and `// @options:` line from `@earendil-works/pi-codemode/source`,
 * and the "Script completed" / "Script failed" result text — and delegates
 * running the script to an injected {@link CodemodeExecutor}, so the same
 * registration runs on Node (QuickJS) and on Cloudflare (Dynamic Workers).
 *
 * Nested calls: a script's `tools.<name>(args)` runs that registration's
 * `execute` with an invocation-scoped API (`callId` `<codemode call>/<n>`,
 * output captured for the script, cancelled with the script), and resolves
 * to its text content; a failed call rejects with its error text. Only the
 * script's output reaches the model. Nested calls do not pass through the
 * harness's argument validation — `prepareArguments` is applied, as the
 * harness does before validating.
 *
 * Pi leaves Pi-coding-agent features out on purpose here: `searchTools`,
 * `describeTool`, `describeNamespace` and `models.*` are TUI-session globals,
 * and spilling truncated output to a temp file needs a filesystem.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import { withAbortSignal } from '@earendil-works/chord/context';
import type { CodemodeJsonSchema } from '@earendil-works/pi-codemode';
import {
	MCP_TYPESCRIPT_PREAMBLE,
	mcpStructuredContentSchema,
	renderToolSample,
	toCodemodeIdentifier,
} from '@earendil-works/pi-codemode/declarations';
import {
	CODEMODE_SOURCE_GRAMMAR,
	CodemodeSourceError,
	parseCodemodeSource,
} from '@earendil-works/pi-codemode/source';
import type {
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from '@earendil-works/pi-durable';
import type {
	CodemodeCall,
	CodemodeExecutor,
	CodemodeResult,
	CodemodeStoreWrites,
	CodemodeTool,
} from './executor.ts';

export const CODEMODE_TOOL_NAME = 'codemode';

/** Pi's default heap limit for a script (`CODEMODE_MEMORY_LIMIT_BYTES`). */
export const DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** Pi's default token budget for a script's output. */
export const DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS = 10_000;
/** Characters per token when estimating, as Pi does. */
const CHARS_PER_TOKEN = 4;

/**
 * Where `store()`/`load()` values live between scripts. Pi's coding agent
 * keeps them as session entries on the branch; a Flue host supplies its own.
 * Without a store, `load()` starts empty and writes are dropped.
 */
export interface CodemodeStore {
	load(api: ToolExecutionApi, context: Context): Promise<Readonly<Record<string, unknown>>>;
	save(writes: CodemodeStoreWrites, api: ToolExecutionApi, context: Context): Promise<void>;
}

export interface CodemodeToolOptions {
	/** Runs the scripts: the Dynamic Worker executor on Cloudflare, `CodemodeSandbox` on Node. */
	readonly executor: CodemodeExecutor;
	/** Tools scripts may call. A tool named `codemode` is left out: scripts do not start scripts. */
	readonly tools: readonly ToolRegistration[];
	readonly store?: CodemodeStore;
	/**
	 * Deadline for a script when its `// @options:` line sets none. Default
	 * `Infinity`, as in Pi: the script runs until it settles or is aborted.
	 */
	readonly timeoutMs?: number;
	/** Default {@link DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES}. */
	readonly memoryLimitBytes?: number;
	/** Output budget when the `// @options:` line sets none. Default {@link DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS}. */
	readonly maxOutputTokens?: number;
}

const CODE_DESCRIPTION =
	'Raw JavaScript source. Top-level await and return work. May start with a `// @options: {"max_output_tokens": 1000}` line.';

const PARAMETERS = {
	type: 'object',
	properties: { code: { type: 'string', description: CODE_DESCRIPTION } },
	required: ['code'],
} as const;

/** Pi's description intro, minus the coding-agent-only discovery and model globals. */
const DESCRIPTION_INTRO = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh sandbox as the body of an async function: top-level \`await\` and \`return\` work.
- All nested tools are available on the global \`tools\` object, for example \`await tools.read(...)\`. Tool names are exposed as normalized JavaScript identifiers, for example \`await tools.mcp__ologs__get_profile(...)\`.
- Nested tool methods take an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- A nested tool call that fails, is blocked, or gets invalid arguments rejects with an Error carrying the tool's error text.
- Runs raw JavaScript -- no Node, no file system, no network access, no timers.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first line like \`// @options: {"max_output_tokens": 1000, "timeout_ms": 60000}\`.
- \`max_output_tokens\` sets the token budget for the script's output. Defaults to 10000 tokens.
- \`timeout_ms\` sets a hard deadline for the whole script. By default there is none.
- When the JS code is fully evaluated, calls that are still running are cancelled and unawaited promises are silently discarded.
- Tool calls are real and have side effects. If the script fails partway, earlier calls are not undone.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem: string | { image_url: string } | ImageContent)\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL. To forward an MCP tool image, pass an individual \`ImageContent\` block from \`result.content\`, for example \`image(result.content[0])\`.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`codemode\` calls in the same session. Storing \`undefined\` deletes the key. Writes are kept only if the script succeeds.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`console.log(...)\` and the other \`console\` methods append a text item like \`text()\`.
- \`return value\` at the top level appends the value like \`text()\`.`;

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: 'string' };

/** What a script sees of a tool: its input schema, and text output. */
function toDeclaration(tool: ToolRegistration): Omit<CodemodeTool, 'execute'> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as unknown as CodemodeJsonSchema,
		outputSchema: TEXT_OUTPUT_SCHEMA,
	};
}

function callableTools(tools: readonly ToolRegistration[]): ToolRegistration[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration, as in Pi. */
function renderToolSection(declaration: Omit<CodemodeTool, 'execute'>): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

/** The model-facing description: Pi's helper list, shared MCP types when needed, one section per tool. */
export function createCodemodeDescription(tools: readonly ToolRegistration[]): string {
	const declarations = callableTools(tools).map(toDeclaration);
	const sections = [DESCRIPTION_INTRO];
	if (declarations.some((declaration) => mcpStructuredContentSchema(declaration.outputSchema) !== undefined)) {
		sections.push(`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
	}
	if (declarations.length > 0) {
		sections.push(['Nested tools:', ...declarations.map(renderToolSection)].join('\n\n'));
	}
	return sections.join('\n\n');
}

type ToolContent = NonNullable<ToolExecutionResult['content']>;

function textOf(content: ToolContent): string {
	return content
		.filter((block): block is Extract<ToolContent[number], { type: 'text' }> => block.type === 'text')
		.map((block) => block.text)
		.join('\n');
}

/** Like the script's `text()`: strings as is, other values as compact JSON. */
function valueText(value: unknown): string {
	if (typeof value === 'string') return value;
	return JSON.stringify(value) ?? String(value);
}

function formatCallSummary(calls: readonly CodemodeCall[]): string {
	if (calls.length === 0) return 'No tool calls were made.';
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(', ')}`;
}

function formatError(result: Extract<CodemodeResult, { ok: false }>): string {
	const { error } = result;
	const head =
		error.kind === 'script'
			? (error.stack ?? `${error.name ?? 'Error'}: ${error.message}`)
			: error.kind === 'timeout'
				? `Script timed out: ${error.message}`
				: error.kind === 'aborted'
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	return `${head}\n\n${formatCallSummary(result.calls)}`;
}

/**
 * Pi's output budget: past it, the text items become one item keeping the
 * start and end, followed by the images. Pi also writes the full text to a
 * temp file; a Flue host has no filesystem to put it in.
 */
function truncateOutput(items: ToolContent, maxTokens: number): ToolContent {
	const texts = items.flatMap((item) => (item.type === 'text' ? [item.text] : []));
	const combined = texts.join('\n');
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return items;
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	const head = combined.slice(0, headChars);
	const tail = tailChars > 0 ? combined.slice(-tailChars) : '';
	const text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split('\n').length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
	return [{ type: 'text', text }, ...items.filter((item) => item.type === 'image')];
}

/** Details recorded on the codemode tool result: the nested calls of the script. */
export interface CodemodeToolDetails {
	readonly calls: { name: string; status: CodemodeCall['status']; durationMs: number }[];
}

export function createCodemodeToolRegistration(options: CodemodeToolOptions): ToolRegistration {
	const tools = callableTools(options.tools);
	return {
		name: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription(tools),
		parameters: PARAMETERS as unknown as ToolRegistration['parameters'],
		// Capable models write the script as raw text instead of a JSON-escaped string.
		constrainedSampling: { type: 'grammar', variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		// Nested calls have side effects; an interrupted script is not rerun.
		replay: 'unsafe',
		async execute(args, api, context): Promise<ToolExecutionResult> {
			const startedAt = performance.now();
			const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? args.code : undefined;
			let source: ReturnType<typeof parseCodemodeSource>;
			try {
				if (typeof input !== 'string') throw new CodemodeSourceError('code must be a string of JavaScript source');
				source = parseCodemodeSource(input);
			} catch (error) {
				if (!(error instanceof CodemodeSourceError)) throw error;
				return { content: [{ type: 'text', text: error.message }], isError: true };
			}

			let nestedCalls = 0;
			const sandboxTools: CodemodeTool[] = tools.map((tool) => ({
				name: tool.name,
				description: renderToolSample(toDeclaration(tool)),
				execute: async (callArgs, { signal }) => {
					const callId = `${api.callId}/${++nestedCalls}`;
					const chunks: string[] = [];
					const decoder = new TextDecoder();
					const nestedApi: ToolExecutionApi = {
						...api,
						callId,
						output: (chunk) => {
							chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
						},
						diagnostic: () => {},
						details: async () => {},
					};
					const prepared = tool.prepareArguments
						? tool.prepareArguments((callArgs ?? {}) as JsonValue)
						: ((callArgs ?? {}) as JsonValue);
					const result = await tool.execute(prepared, nestedApi, withAbortSignal(signal, context));
					const text = result.content === undefined ? chunks.join('') : textOf(result.content);
					if (result.isError) throw new Error(text || `Tool "${tool.name}" failed`);
					return text;
				},
			}));

			const store = options.store ? await options.store.load(api, context) : {};
			const timeoutMs = source.options.timeoutMs ?? options.timeoutMs ?? Number.POSITIVE_INFINITY;
			const result = await options.executor.execute(source.code, sandboxTools, {
				timeoutMs,
				memoryLimitBytes: options.memoryLimitBytes ?? DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES,
				store,
				...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			});

			const items: ToolContent = result.output.map(
				(item): ToolContent[number] =>
					item.type === 'text' ? { type: 'text', text: item.text } : item,
			);
			if (result.ok) {
				const { set, delete: deleted } = result.storeWrites;
				if (options.store && (Object.keys(set).length > 0 || deleted.length > 0)) {
					await options.store.save(result.storeWrites, api, context);
				}
				if (result.value !== undefined) items.push({ type: 'text', text: valueText(result.value) });
			} else {
				items.push({ type: 'text', text: `Script error:\n${formatError(result)}` });
			}
			const truncated = truncateOutput(
				items,
				source.options.maxOutputTokens ?? options.maxOutputTokens ?? DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS,
			);
			const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
			const header = `${result.ok ? 'Script completed' : 'Script failed'}\nWall time ${wallTime} seconds\nOutput:\n`;
			const details: CodemodeToolDetails = {
				calls: result.calls.map((call) => ({ name: call.name, status: call.status, durationMs: call.durationMs })),
			};
			return {
				content: [{ type: 'text', text: header }, ...truncated],
				details: details as unknown as JsonValue,
				...(result.ok ? {} : { isError: true }),
			};
		},
	};
}
