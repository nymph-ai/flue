/**
 * The `codemode` tool: Pi's Code Mode (`@earendil-works/pi-codemode`) as one
 * Pi Durable `ToolRegistration` (docs/cloudflare-native.md rule 7). Scripts
 * run in a QuickJS VM in the agent's own isolate (`sandbox.ts`) and see what
 * a script sees in Pi's coding agent, so a script written for Pi runs here
 * unchanged:
 *
 * - `tools.<name>(args)` for every other tool of the render — the agent's own
 *   tools by name, an MCP server's as `mcp__<server>__<tool>` — and
 *   `ALL_TOOLS`, `searchTools()`, `describeTool()`, `describeNamespace()`;
 * - `text()`, `image()`, `exit()`, `console.*` and `return`;
 * - `store(key, value)` / `load(key)`, kept per conversation in a Pi
 *   document ({@link FlueCodemodeStore}) from the result's `storeWrites`;
 * - `models.getModelsOfType()`, `getAvailableOfType()`, `getModelOfType()`
 *   and `classify()` over the runtime's pi-ai models, at most
 *   {@link MAX_CONCURRENT_MODEL_CALLS} classifications at once.
 *
 * Nested results follow Pi: an MCP tool resolves to its whole
 * `CallToolResult` (without `_meta`), `isError` included; another tool to its
 * structured output when it has one, else its text; a failed call rejects
 * with the tool's error text. The description is Pi's (`pi-coding-agent`
 * `extensions/codemode/tool.ts`), listing every callable tool's declaration
 * within a token budget.
 *
 * Flue adds approvals. A tool `useCodeMode({ requiresApproval })` names asks
 * before it runs (the question seam, `questions.ts`); the script waits, and
 * a rejection rejects that call. A question parks inside Pi with the turn
 * left open (`pi/questions.ts`). The VM itself lives only in memory, so the
 * nested calls of a script that asks are journaled (`journal.ts`): if the
 * Durable Object is evicted while it waits, Pi reruns this call on the next
 * wake (it is registered `replay: "safe"` for that), the script runs again
 * with the journaled results answering its earlier calls, and the parked
 * call takes the answer — exactly once. A rerun of a call that never parked
 * settles as interrupted, as `replay: "unsafe"` would.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import { withContextValue } from '@earendil-works/chord/context';
import type { ClassifierApi, ClassifierModel, Models } from '@earendil-works/pi-ai';
import {
	type CodemodeJsonSchema,
	type CodemodeOutputItem,
	type CodemodeResult,
	CodemodeSandbox,
	CodemodeSourceError,
	type CodemodeTool,
	MCP_TYPESCRIPT_PREAMBLE,
	mcpStructuredContentSchema,
	parseCodemodeSource,
	renderDeclarations,
	renderToolSample,
	toCodemodeIdentifier,
} from '@earendil-works/pi-codemode';
import type {
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from '@earendil-works/pi-durable';
import { fnv1a64 } from '../fnv.ts';
import type { McpToolAnnotations } from '../mcp-types.ts';
import { beginQuestionableCall, cancelQuestion } from '../pi/questions.ts';
import {
	askQuestion,
	type CodemodeApprovalQuestion,
	type FlueAnswer,
	type FlueQuestion,
	QUESTION_HANDLER,
	QuestionParkedError,
	type QuestionHandler,
	runInQuestionCall,
} from '../questions.ts';
import { getRuntimeModels } from '../runtime/providers.ts';
import { getMcpToolSource, type McpCallResult, type McpToolSource } from '../tool-adapter.ts';
import { CallJournal, callBase, callKey, type JournalOutcome } from './journal.ts';
import {
	DEFAULT_CPU_BUDGET,
	DEFAULT_MEMORY_LIMIT_BYTES,
	inProcessVm,
	quickJSWasm,
} from './sandbox.ts';
import { FlueCodemodeStore } from './store.ts';

export const CODEMODE_TOOL_NAME = 'codemode';

/** Default token budget for a script's output (Pi's). */
export const DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS = 10_000;

/** Token budget of the tool declarations in the description (Pi's `codemode.inlineBudget`). */
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;

/** Classifier calls one script may have in flight; `Promise.all` over many items queues the rest. */
export const MAX_CONCURRENT_MODEL_CALLS = 4;

const CHARS_PER_TOKEN = 4;
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
const MODEL_TYPES = new Set(['chat', 'image', 'classifier']);

/** One callable tool, as `useCodeMode({ requiresApproval })` sees it. */
export interface CodemodeMethod {
	/** The tool's name, which scripts call: `tools.<name>` (as an identifier). */
	readonly name: string;
	/** The MCP server, for MCP tools. */
	readonly server?: string;
	/** The MCP server's own name for the tool, for MCP tools. */
	readonly tool?: string;
	/** The MCP server's annotations for the tool (untrusted hints), when it sent any. */
	readonly annotations?: McpToolAnnotations;
}

export interface CodemodeToolOptions {
	/** Tools a script may call: the render's tools and MCP tools; a tool named `codemode` is left out. */
	readonly tools: readonly ToolRegistration[];
	/** `useCodeMode({ requiresApproval })`: tool names, `*` patterns, or a predicate. */
	readonly requiresApproval?: readonly string[] | ((method: CodemodeMethod) => boolean);
	/** Output budget, in tokens (≈4 characters each). Default 10 000. */
	readonly maxOutputTokens?: number;
	/** Wall-clock deadline of one script; a script's `timeout_ms` option overrides it. Default: none. */
	readonly timeoutMs?: number;
	/** The VM's heap limit. Default 32 MiB. */
	readonly memoryLimitBytes?: number;
	/** Interrupt polls one script may use (`sandbox.ts`). Default {@link DEFAULT_CPU_BUDGET}. */
	readonly cpuBudget?: number;
}

/** One nested call, as the tool result's details record it (Pi's `CodemodeCallRecord`). */
export interface CodemodeCallRecord {
	id: string;
	name: string;
	args: string;
	status: 'running' | 'ok' | 'error' | 'cancelled';
	durationMs?: number;
	error?: string;
}

/** Details recorded on the codemode tool result. */
export interface CodemodeToolDetails {
	/** `<conversation>:<call id>`: what a question of this execution names. */
	readonly executionId: string;
	readonly status: 'completed' | 'error' | 'parked';
	readonly calls: CodemodeCallRecord[];
	/** The question the execution waits on, when parked. */
	readonly questionId?: string;
}

// ─── The description (Pi's) ─────────────────────────────────────────────────

function descriptionIntro(memoryLimitBytes: number, approvals: boolean): string {
	const megabytes = Math.round(memoryLimitBytes / (1024 * 1024));
	return `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh QuickJS sandbox as the body of an async function: top-level \`await\` and \`return\` work.
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
- Scripts have a ${megabytes} MB memory limit; exceeding it throws \`InternalError: out of memory\`. Filter or aggregate large data instead of accumulating it.${
		approvals
			? `
- Some nested tools need a person's approval: the call waits until it is answered, and a rejected call rejects with an Error. Do not run the script again while it waits.`
			: ''
	}

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem: string | { image_url: string } | ImageContent)\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL. To forward an MCP tool image, pass an individual \`ImageContent\` block from \`result.content\`, for example \`image(result.content[0])\`.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`codemode\` calls in the same session. Storing \`undefined\` deletes the key. Writes are kept only if the script succeeds.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`searchTools(query: string, options?: { limit?: number; namespace?: string })\`: resolves to the nested tools that best match the query (BM25, default limit 8), as \`{ name, description }\` entries like \`ALL_TOOLS\`.
- \`describeTool(name: string)\`: resolves to the description and declaration of a nested tool, or \`undefined\`.
- \`describeNamespace(name: string)\`: resolves to \`{ name, description?, instructions?, tools }\` for a namespace of nested tools, such as an MCP server: its usage instructions and the names of its tools, or \`undefined\`.
- \`console.log(...)\` and the other \`console\` methods append a text item like \`text()\`.
- \`return value\` at the top level appends the value like \`text()\`.`;
}

const DEFERRED_TOOLS_GUIDANCE = `Some nested tools may be omitted from this description, such as deferred tools and MCP tools. They are still available on the global \`tools\` object and listed in \`ALL_TOOLS\`.
To find one, call \`await searchTools(query)\` (pass \`{ namespace }\` to search one namespace), or filter \`ALL_TOOLS\` by \`name\` and \`description\`. \`await describeNamespace(name)\` returns a namespace's usage instructions and the names of its tools.`;

const MODEL_API_TYPES = `type ModelType = "chat" | "image" | "classifier";
/** A model catalog entry. \`provider\` and \`id\` identify it; the other fields depend on the type. */
interface ModelInfo {
  type?: ModelType;
  provider: string;
  id: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  contextWindow?: number;
  [key: string]: unknown;
}
type ClassifierQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };
type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };
interface ClassifierContext {
  state: Record<string, unknown>;
  questions: Record<string, ClassifierQuestion>;
}
interface ClassifierResult {
  api: string;
  provider: string;
  model: string;
  answers: Record<string, ClassifierAnswer>;
  /** Set when the service reports token counts. Cost is in USD. */
  usage?: { input: number; output: number; totalTokens: number; cost: { total: number } };
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}`;

/** The `models` globals (Pi's `MODEL_GLOBAL_DECLARATIONS`). */
const MODEL_GLOBAL_DECLARATIONS = [
	{
		name: 'models.getModelsOfType',
		description: 'Every known model of a type, optionally for one provider.',
		signature: '(type: ModelType, provider?: string): Promise<ModelInfo[]>',
	},
	{
		name: 'models.getAvailableOfType',
		description: 'Models of a type whose provider has working credentials.',
		signature: '(type: ModelType, provider?: string): Promise<ModelInfo[]>',
	},
	{
		name: 'models.getModelOfType',
		description: 'One catalog entry, or undefined.',
		signature: '(type: ModelType, provider: string, id: string): Promise<ModelInfo | undefined>',
	},
	{
		name: 'models.classify',
		description:
			'Run a classifier model on one state. Only `provider` and `id` of `model` are used. Provider errors do not throw: check `stopReason` and `errorMessage`.',
		signature: '(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>',
	},
] as const;

/** A namespace of nested tools: one MCP server. */
interface Namespace {
	readonly name: string;
	readonly description?: string;
	readonly instructions?: string;
}

/** One tool a script may call. */
interface Callable {
	readonly registration: ToolRegistration;
	readonly declaration: Pick<CodemodeTool, 'name' | 'description' | 'inputSchema' | 'outputSchema'>;
	readonly sample: string;
	readonly namespace?: Namespace;
	readonly source?: McpToolSource;
	readonly method: CodemodeMethod;
}

/** Pi's `mcpNamespace(server)`. */
function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, '_')}`;
}

/** The `CallToolResult` output schema of every MCP tool (Pi's `createMcpResultSchema`). */
function mcpResultSchema(structuredContentSchema: object | undefined): CodemodeJsonSchema {
	return {
		type: 'object',
		properties: {
			content: { type: 'array', items: { type: 'object' } },
			...(structuredContentSchema ? { structuredContent: structuredContentSchema } : {}),
			isError: { type: 'boolean' },
			_meta: { type: 'object' },
		},
		required: ['content'],
	};
}

function callables(tools: readonly ToolRegistration[]): Callable[] {
	return tools
		.filter((tool) => tool.name !== CODEMODE_TOOL_NAME)
		.map((registration) => {
			const source = getMcpToolSource(registration);
			const declaration = {
				name: registration.name,
				description: registration.description,
				inputSchema: (source?.tool.inputSchema ?? registration.parameters) as CodemodeJsonSchema,
				// A Flue tool resolves to its structured output when it has one, so
				// its result type is left undeclared (Pi declares text).
				...(source ? { outputSchema: mcpResultSchema(source.tool.outputSchema) } : {}),
			};
			return {
				registration,
				declaration,
				sample: renderToolSample(declaration),
				...(source
					? {
							source,
							namespace: {
								name: mcpNamespace(source.server),
								...(source.instructions ? { instructions: source.instructions } : {}),
							},
						}
					: {}),
				method: {
					name: registration.name,
					...(source
						? {
								server: source.server,
								tool: source.tool.name,
								...(source.tool.annotations ? { annotations: source.tool.annotations } : {}),
							}
						: {}),
				},
			};
		});
}

/** `### \`id\` (\`raw name\`)` followed by the tool's declaration (Pi's `renderToolSection`). */
function renderToolSection(callable: Callable): string {
	const id = toCodemodeIdentifier(callable.declaration.name);
	const heading =
		id === callable.declaration.name
			? `### \`${id}\``
			: `### \`${id}\` (\`${callable.declaration.name}\`)`;
	return `${heading}\n${callable.sample.trim()}`;
}

type Group = {
	namespace: Namespace | undefined;
	entries: { name: string; section: string; cost: number }[];
};

/** Pi's `selectCatalog`: every namespace is represented before any is complete. */
function selectCatalog(groups: readonly Group[], budget: number): Set<string> {
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0] as Group['entries'][number];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

/** Pi's `createCodemodeDescription` over every callable tool, with the `models` API. */
function createCodemodeDescription(
	tools: readonly Callable[],
	options: { inlineBudget: number; memoryLimitBytes: number; approvals: boolean },
): string {
	const groups = new Map<string, Group>([['', { namespace: undefined, entries: [] }]]);
	for (const tool of tools) {
		const key = tool.namespace ? `ns:${tool.namespace.name}` : '';
		const group = groups.get(key) ?? { namespace: tool.namespace, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(tool);
		group.entries.push({
			name: tool.declaration.name,
			section,
			cost: Math.ceil(section.length / CHARS_PER_TOKEN),
		});
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined
			? -1
			: b.namespace === undefined
				? 1
				: a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, options.inlineBudget);
	const sections = [
		descriptionIntro(options.memoryLimitBytes, options.approvals),
		DEFERRED_TOOLS_GUIDANCE,
	];
	if (
		tools.some(
			(tool) =>
				shown.has(tool.declaration.name) &&
				mcpStructuredContentSchema(tool.declaration.outputSchema) !== undefined,
		)
	) {
		sections.push(`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
	}
	const models = renderDeclarations({
		globals: MODEL_GLOBAL_DECLARATIONS.map((global) => ({ ...global, execute: () => undefined })),
	});
	sections.push(`Model API:\n\`\`\`ts\n${MODEL_API_TYPES}\n\n${models}\n\`\`\``);
	if (tools.length === 0) return sections.join('\n\n');
	const toolSections = ['Nested tools:'];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			const listing =
				visible.length === entries.length
					? ''
					: visible.length === 0
						? ' (tools not listed)'
						: ' (some tools not listed)';
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ''}`);
		}
		for (const entry of visible) toolSections.push(entry.section);
	}
	sections.push(toolSections.join('\n\n'));
	return sections.join('\n\n');
}

// ─── Discovery globals (Pi's `searchTools`, `describeTool`, `describeNamespace`) ──

const DEFAULT_TOOL_SEARCH_LIMIT = 8;
const STOP_WORDS = new Set(
	'a an and are as at be by for from in is it of on or that the this to with'.split(' '),
);

function stem(term: string): string {
	if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
	return term;
}

function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === 'string') parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ['anyOf', 'oneOf', 'allOf']) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

function searchDocument(tool: Callable): { name: string; text: string } {
	const name = tool.declaration.name;
	const parts = [name, name.replaceAll('_', ' '), tool.declaration.description ?? ''];
	schemaText(tool.declaration.inputSchema, parts);
	if (tool.namespace) {
		parts.push(
			tool.namespace.name,
			tool.namespace.description ?? '',
			tool.namespace.instructions ?? '',
		);
	}
	return { name, text: parts.filter((part) => part.trim()).join(' ') };
}

/** Okapi BM25 (k1 1.2, b 0.75); ties keep document order. */
function rank(
	query: string,
	documents: readonly { name: string; text: string }[],
	limit: number,
): string[] {
	const queryTerms = [...new Set(tokenize(query))];
	if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
	const termCounts = documents.map((document) => {
		const counts = new Map<string, number>();
		for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
		return counts;
	});
	const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, n) => sum + n, 0));
	const averageLength = lengths.reduce((sum, n) => sum + n, 0) / documents.length || 1;
	const idf = new Map(
		queryTerms.map((term) => {
			const frequency = termCounts.filter((counts) => counts.has(term)).length;
			return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
		}),
	);
	const matches: { name: string; score: number }[] = [];
	documents.forEach((document, index) => {
		let score = 0;
		for (const term of queryTerms) {
			const count = termCounts[index]?.get(term);
			if (!count) continue;
			const norm = 1.2 * (1 - 0.75 + (0.75 * (lengths[index] ?? 0)) / averageLength);
			score += (idf.get(term) ?? 0) * ((count * 2.2) / (count + norm));
		}
		if (score > 0) matches.push({ name: document.name, score });
	});
	return matches
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((match) => match.name);
}

function isNamespaceName(namespace: string, query: string): boolean {
	const id = toCodemodeIdentifier(namespace);
	const queryId = toCodemodeIdentifier(query);
	const suffix = (name: string) =>
		name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : undefined;
	return (
		namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId
	);
}

function discoveryGlobals(tools: readonly Callable[]): CodemodeTool[] {
	const entry = (tool: Callable) => ({
		name: toCodemodeIdentifier(tool.declaration.name),
		description: tool.sample,
	});
	return [
		{
			name: 'searchTools',
			spread: true,
			execute: (args) => {
				const [query, options] = args as [unknown, { limit?: unknown; namespace?: unknown }?];
				if (typeof query !== 'string') throw new Error('searchTools() expects a query string');
				const limit = options?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
					throw new Error('searchTools() limit must be a positive integer');
				}
				const namespace = options?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== 'string') {
					throw new Error('searchTools() namespace must be a string');
				}
				const candidates = tools.filter(
					(tool) =>
						!namespace || (tool.namespace && isNamespaceName(tool.namespace.name, namespace)),
				);
				const byName = new Map(candidates.map((tool) => [tool.declaration.name, tool]));
				return rank(query, candidates.map(searchDocument), limit).map((name) =>
					entry(byName.get(name) as Callable),
				);
			},
		},
		{
			name: 'describeTool',
			spread: true,
			execute: (args) => {
				const [name] = args as [unknown];
				if (typeof name !== 'string') throw new Error('describeTool() expects a tool name');
				return tools.find(
					(tool) =>
						tool.declaration.name === name || toCodemodeIdentifier(tool.declaration.name) === name,
				)?.sample;
			},
		},
		{
			name: 'describeNamespace',
			spread: true,
			execute: (args) => {
				const [name] = args as [unknown];
				if (typeof name !== 'string')
					throw new Error('describeNamespace() expects a namespace name');
				const members = tools.filter(
					(tool) => tool.namespace && isNamespaceName(tool.namespace.name, name),
				);
				const namespace = members[0]?.namespace;
				if (!namespace) return undefined;
				return {
					name: namespace.name,
					...(namespace.description ? { description: namespace.description } : {}),
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					tools: members.map((tool) => toCodemodeIdentifier(tool.declaration.name)),
				};
			},
		},
	];
}

// ─── `models.*` ─────────────────────────────────────────────────────────────

function toModelType(value: unknown): 'chat' | 'image' | 'classifier' {
	if (typeof value === 'string' && MODEL_TYPES.has(value)) return value as never;
	throw new Error(
		`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`,
	);
}

function toProvider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new Error('provider must be a string');
	return value;
}

/** A catalog entry for scripts, without `headers` (they can carry credentials). */
function toModelInfo(model: object): Record<string, unknown> {
	const { headers: _headers, ...info } = model as Record<string, unknown>;
	return info;
}

/** Runs at most `limit` calls at once, in call order. */
function createLimiter(limit: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(run: () => Promise<T>): Promise<T> => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

function modelGlobals(models: Models, callId: string, calls: CodemodeCallRecord[]): CodemodeTool[] {
	const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS);
	let classifyCount = 0;
	const implementations: Record<string, CodemodeTool['execute']> = {
		'models.getModelsOfType': (args) => {
			const [type, provider] = args as unknown[];
			return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
		},
		'models.getAvailableOfType': async (args, { signal }) => {
			const [type, provider] = args as unknown[];
			const available = await models.getAvailableOfType(toModelType(type), toProvider(provider), {
				signal,
			});
			return available.map(toModelInfo);
		},
		'models.getModelOfType': (args) => {
			const [type, provider, id] = args as unknown[];
			if (typeof provider !== 'string' || typeof id !== 'string') {
				throw new Error('models.getModelOfType() expects a type, a provider, and an id');
			}
			const model = models.getModelOfType(toModelType(type), provider, id);
			return model === undefined ? undefined : toModelInfo(model);
		},
		'models.classify': async (args, { signal }) => {
			const [model, context] = args as [unknown, unknown];
			const ref = model as { provider?: unknown; id?: unknown } | null;
			if (
				typeof ref !== 'object' ||
				ref === null ||
				typeof ref.provider !== 'string' ||
				typeof ref.id !== 'string'
			) {
				throw new Error(
					'models.classify() expects a model from models.getModelOfType() or models.getAvailableOfType()',
				);
			}
			// Only provider and id count: a script-supplied baseUrl or headers never receive credentials.
			const resolved = models.getModelOfType('classifier', ref.provider, ref.id) as
				ClassifierModel<ClassifierApi> | undefined;
			if (!resolved) throw new Error(`Unknown classifier model "${ref.provider}/${ref.id}"`);
			const record: CodemodeCallRecord = {
				id: `${callId}/models.classify/${++classifyCount}`,
				name: 'models.classify',
				args: `${resolved.provider}/${resolved.id}`,
				status: 'running',
			};
			calls.push(record);
			const startedAt = performance.now();
			const result = await limit(() => models.classify(resolved, context as never, { signal }));
			record.durationMs = performance.now() - startedAt;
			record.status =
				result.stopReason === 'stop'
					? 'ok'
					: result.stopReason === 'aborted'
						? 'cancelled'
						: 'error';
			if (result.errorMessage) record.error = truncate(result.errorMessage, ERROR_PREVIEW_CHARS);
			return result;
		},
	};
	return MODEL_GLOBAL_DECLARATIONS.map((declaration) => ({
		name: declaration.name,
		spread: true,
		execute: implementations[declaration.name] as CodemodeTool['execute'],
	}));
}

// ─── Results ────────────────────────────────────────────────────────────────

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function previewArgs(args: unknown): string {
	if (args === undefined) return '';
	try {
		return truncate(JSON.stringify(args) ?? '', ARGS_PREVIEW_CHARS);
	} catch {
		return '';
	}
}

/** Like the script's `text()`: strings as is, other values as compact JSON. */
function valueText(value: unknown): string {
	if (typeof value === 'string') return value;
	return JSON.stringify(value) ?? String(value);
}

function formatError(
	result: Extract<CodemodeResult, { ok: false }>,
	calls: readonly CodemodeCallRecord[],
): string {
	const { error } = result;
	const head =
		error.kind === 'script'
			? (error.stack ?? `${error.name ?? 'Error'}: ${error.message}`)
			: error.kind === 'timeout'
				? `Script timed out: ${error.message}`
				: error.kind === 'aborted'
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	const summary =
		calls.length === 0
			? 'No tool calls were made.'
			: `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(', ')}`;
	return `${head}\n\n${summary}`;
}

/**
 * Pi's token budget: text beyond it keeps its start and end around a marker,
 * images follow. Pi also writes the whole text to a temp file; an agent's
 * Durable Object has no file system, so the middle is dropped.
 */
function truncateOutput(items: CodemodeOutputItem[], maxTokens: number): CodemodeOutputItem[] {
	const texts = items.flatMap((item) => (item.type === 'text' ? [item.text] : []));
	const combined = texts.join('\n');
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return items;
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	const text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split('\n').length}\n\n${combined.slice(0, headChars)}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tailChars > 0 ? combined.slice(-tailChars) : ''}`;
	return [{ type: 'text', text }, ...items.filter((item) => item.type === 'image')];
}

// ─── Nested calls ───────────────────────────────────────────────────────────

/** The parked question that ended an execution early (case 2 of the question seam). */
class Parked extends Error {
	constructor(readonly question: QuestionParkedError['question']) {
		super(`[flue] Waiting for an answer to ${question.id}.`);
	}
}

function textOf(result: ToolExecutionResult, chunks: readonly string[]): string {
	return result.content === undefined
		? chunks.join('')
		: result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** An MCP result as a script receives it: the `CallToolResult` without `_meta` or the protocol's `resultType`. */
function mcpScriptValue(result: McpCallResult): JsonValue {
	const {
		_meta: _ignored,
		resultType: _type,
		...value
	} = result as McpCallResult & {
		_meta?: unknown;
		resultType?: unknown;
	};
	return value as JsonValue;
}

type Resume = (
	question: CodemodeApprovalQuestion,
	answer: FlueAnswer,
	api: ToolExecutionApi,
	context: Context,
) => Promise<ToolExecutionResult>;

const RESUME = Symbol('flue.codemode.resume');

const PARAMETERS = {
	type: 'object',
	properties: {
		code: {
			type: 'string',
			description:
				'Raw JavaScript source. Top-level await and return work. May start with a `// @options: {"max_output_tokens": 1000}` line.',
		},
	},
	required: ['code'],
	additionalProperties: false,
} as const;

function approvalPolicy(
	option: CodemodeToolOptions['requiresApproval'],
): (method: CodemodeMethod) => boolean {
	if (option === undefined) return () => false;
	if (typeof option === 'function') return (method) => option(method) === true;
	const patterns = option.map(
		(pattern) =>
			new RegExp(
				`^${pattern
					.split('*')
					.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
					.join('.*')}$`,
			),
	);
	return (method) =>
		patterns.some(
			(pattern) => pattern.test(method.name) || pattern.test(toCodemodeIdentifier(method.name)),
		);
}

export function createCodemodeToolRegistration(options: CodemodeToolOptions): ToolRegistration {
	const tools = callables(options.tools);
	const requiresApproval = approvalPolicy(options.requiresApproval);
	const approvals = options.requiresApproval !== undefined;
	const memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
	const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS;

	/**
	 * Run `code` once to a result. `journal` answers calls an earlier run made;
	 * `parkedOn` is the question that run parked on, and `answered` an answer
	 * the caller already holds for it.
	 */
	const run = async (
		code: string,
		journal: CallJournal,
		executionId: string,
		api: ToolExecutionApi,
		context: Context,
		parkedOn?: FlueQuestion,
		answered?: FlueAnswer,
	): Promise<ToolExecutionResult> => {
		const startedAt = performance.now();
		let parsed: ReturnType<typeof parseCodemodeSource>;
		try {
			parsed = parseCodemodeSource(code);
		} catch (error) {
			if (!(error instanceof CodemodeSourceError)) throw error;
			return { content: [{ type: 'text', text: error.message }], isError: true };
		}
		const calls: CodemodeCallRecord[] = [];
		const stop = new AbortController();
		let parked: Parked | undefined;
		const occurrences = new Map<string, number>();
		let nested = 0;

		// A question asked below a nested call (deep in the MCP client) first
		// writes the journal, naming the call, then goes to the instance's handler.
		const questionCallFor = (key: string) => {
			const ask: QuestionHandler = async (question, signal) => {
				await journal.persist({ key, questionId: question.id });
				return runInQuestionCall({ api, context }, () => askQuestion(question, signal));
			};
			return { api, context: withContextValue(QUESTION_HANDLER, ask, context) };
		};

		const approve = async (tool: Callable, key: string, args: unknown, seq: number) => {
			const id = `codemode:${executionId}:${fnv1a64(key).slice(0, 12)}`;
			const question: CodemodeApprovalQuestion = {
				kind: 'codemode-approval',
				id,
				executionId,
				pending: [
					{ seq, connector: 'tools', method: toCodemodeIdentifier(tool.method.name), args },
				],
				conversationId: String(api.conversationId),
				callId: api.callId,
			};
			let answer: FlueAnswer;
			if (answered && parkedOn?.id === id) {
				answer = answered;
			} else {
				try {
					await journal.persist();
					answer = await runInQuestionCall({ api, context }, () =>
						askQuestion(question, context.abortSignal),
					);
				} catch (error) {
					if (error instanceof QuestionParkedError) throw new Parked(error.question);
					throw error;
				}
			}
			if (answer.kind !== 'codemode-approval') {
				throw new Error(`[flue] ${id} needs a codemode-approval answer.`);
			}
			if (answer.decision === 'reject') {
				throw new Error(
					`The approval of tools.${toCodemodeIdentifier(tool.method.name)} was rejected${answer.reason ? `: ${answer.reason}` : '.'}`,
				);
			}
		};

		const invoke = async (
			tool: Callable,
			key: string,
			args: unknown,
			signal: AbortSignal,
		): Promise<JsonValue> => {
			const questionCall = questionCallFor(key);
			if (tool.source) {
				const source = tool.source;
				// The call an earlier run parked on input_required: wait for the
				// answer and send the request again with it and the server's state.
				const resumeWith =
					parkedOn?.kind === 'mcp-input' && journal.askedBy(key) === parkedOn.id
						? parkedOn
						: undefined;
				const result = await runInQuestionCall(questionCall, () =>
					resumeWith && source.resume
						? source.resume(resumeWith, signal)
						: source.call((args ?? {}) as Record<string, unknown>, signal),
				);
				return mcpScriptValue(result);
			}
			const chunks: string[] = [];
			const decoder = new TextDecoder();
			const nestedApi: ToolExecutionApi = {
				...api,
				callId: `${api.callId}/${++nested}`,
				output: (chunk) => {
					chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
				},
				diagnostic: () => {},
				details: async () => {},
			};
			const raw = (args ?? {}) as JsonValue;
			const prepared = tool.registration.prepareArguments
				? tool.registration.prepareArguments(raw)
				: raw;
			const result = await runInQuestionCall(questionCall, () =>
				tool.registration.execute(prepared, nestedApi, questionCall.context),
			);
			const text = textOf(result, chunks);
			if (result.isError) throw new Error(text || `Tool "${tool.registration.name}" failed`);
			const output = (result.details as { output?: JsonValue } | undefined)?.output;
			return output !== undefined ? output : text;
		};

		const sandboxTools: CodemodeTool[] = tools.map((tool) => ({
			name: tool.declaration.name,
			description: tool.sample,
			execute: async (args, { signal }) => {
				const base = callBase(tool.declaration.name, args);
				const occurrence = occurrences.get(base) ?? 0;
				occurrences.set(base, occurrence + 1);
				const key = callKey(base, occurrence);
				const record: CodemodeCallRecord = {
					id: `${api.callId}/${calls.length + 1}`,
					name: tool.declaration.name,
					args: previewArgs(args),
					status: 'running',
				};
				calls.push(record);
				const callStartedAt = performance.now();
				const settle = (outcome: JournalOutcome): JsonValue | null => {
					record.durationMs = performance.now() - callStartedAt;
					record.status = outcome.ok ? 'ok' : signal.aborted ? 'cancelled' : 'error';
					if (!outcome.ok) {
						record.error = truncate(outcome.error, ERROR_PREVIEW_CHARS);
						throw new Error(outcome.error);
					}
					return outcome.value;
				};
				const replayed = journal.take(key);
				if (replayed) return settle(replayed);
				let outcome: JournalOutcome;
				try {
					if (requiresApproval(tool.method)) await approve(tool, key, args, calls.length - 1);
					outcome = { ok: true, value: await invoke(tool, key, args, signal) };
				} catch (error) {
					const parkedHere =
						error instanceof QuestionParkedError
							? new Parked(error.question)
							: error instanceof Parked
								? error
								: undefined;
					if (parkedHere) {
						parked ??= parkedHere;
						stop.abort(parkedHere);
						throw parkedHere;
					}
					outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
				await journal.record(key, outcome);
				return settle(outcome);
			},
		}));

		const vm = inProcessVm(options.cpuBudget ?? DEFAULT_CPU_BUDGET);
		const sandbox = new CodemodeSandbox({
			tools: sandboxTools,
			globals: [...discoveryGlobals(tools), ...modelGlobals(getRuntimeModels(), api.callId, calls)],
			timeoutMs: parsed.options.timeoutMs ?? options.timeoutMs ?? Number.POSITIVE_INFINITY,
			memoryLimitBytes,
			wasm: await quickJSWasm(),
			spawn: vm.spawn,
		});
		const signal = context.abortSignal
			? AbortSignal.any([context.abortSignal, stop.signal])
			: stop.signal;
		const stored =
			(await api.snapshot(FlueCodemodeStore, api.conversationId, context))?.values ?? {};
		let result: CodemodeResult;
		try {
			result = await sandbox.execute(parsed.code, { signal, store: stored });
		} finally {
			await sandbox.close();
		}
		for (const call of calls) if (call.status === 'running') call.status = 'cancelled';
		const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
		const details = (status: CodemodeToolDetails['status'], questionId?: string) =>
			({
				executionId,
				status,
				calls,
				...(questionId ? { questionId } : {}),
			}) satisfies CodemodeToolDetails as unknown as JsonValue;

		if (parked) {
			const question = parked.question;
			const waitingOn =
				question.kind === 'codemode-approval'
					? `${question.pending.map((action) => `tools.${action.method}`).join(', ')} needs approval`
					: `MCP server "${question.server}" needs input`;
			return {
				content: [
					{
						type: 'text',
						text: `Script paused (${wallTime}s): ${waitingOn} (question ${question.id}). It continues on its own once answered; do not run the code again.`,
					},
				],
				details: details('parked', question.id),
			};
		}
		await journal.close();

		const items: CodemodeOutputItem[] = [...result.output];
		if (result.ok) {
			const { set, delete: deleted } = result.storeWrites;
			if (Object.keys(set).length > 0 || deleted.length > 0) {
				await api.commit(async (tx) => {
					const doc = await tx.doc(FlueCodemodeStore, api.conversationId);
					for (const key of deleted) delete doc.values[key];
					for (const [key, value] of Object.entries(set)) doc.values[key] = value as never;
				}, context);
			}
			// Pi's extension: a returned value is appended like text().
			if (result.value !== undefined) items.push({ type: 'text', text: valueText(result.value) });
		} else {
			const failed =
				vm.exhausted() && result.error.kind !== 'timeout' && result.error.kind !== 'aborted'
					? {
							...result,
							error: {
								kind: 'timeout' as const,
								message: `the script used its whole CPU budget (${options.cpuBudget ?? DEFAULT_CPU_BUDGET} interrupt polls) and was stopped`,
							},
						}
					: result;
			items.push({ type: 'text', text: `Script error:\n${formatError(failed, calls)}` });
		}
		const header = `${result.ok ? 'Script completed' : 'Script failed'}\nWall time ${wallTime} seconds\nOutput:\n`;
		const budget = parsed.options.maxOutputTokens ?? maxOutputTokens;
		return {
			content: [{ type: 'text', text: header }, ...truncateOutput(items, budget)],
			details: details(result.ok ? 'completed' : 'error'),
			...(result.ok ? {} : { isError: true }),
		};
	};

	const executeCall = async (
		args: JsonValue,
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult> => {
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
		const executionId = `${String(api.conversationId)}:${api.callId}`;
		const begun = await beginQuestionableCall(api, context);
		if (begun.kind === 'first') {
			return run(
				code,
				CallJournal.fresh(executionId, api, context, code),
				executionId,
				api,
				context,
			);
		}
		if (begun.kind === 'resume') {
			// Pi reran a call parked on a question: run the script again over its journal.
			const recorded = await CallJournal.recorded(executionId, api, context);
			if (recorded) return run(code, recorded.journal, executionId, api, context, begun.question);
		}
		if (begun.question) await cancelQuestion(api, begun.question.id, Date.now(), context);
		return {
			content: [
				{
					type: 'text',
					text: 'The codemode call was interrupted (the agent restarted) and may have partly run: calls it made are not undone. Check their effects before running the code again.',
				},
			],
			isError: true,
		};
	};

	const resume: Resume = async (question, answer, api, context) => {
		const recorded = await CallJournal.recorded(question.executionId, api, context);
		if (!recorded) {
			return {
				content: [
					{
						type: 'text',
						text: `Execution ${question.executionId} has nothing to continue: it already settled.`,
					},
				],
				isError: true,
			};
		}
		return run(
			recorded.code,
			recorded.journal,
			question.executionId,
			api,
			context,
			question,
			answer,
		);
	};

	const registration: ToolRegistration = {
		name: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription(tools, {
			inlineBudget: DEFAULT_CODEMODE_INLINE_BUDGET,
			memoryLimitBytes,
			approvals,
		}),
		parameters: PARAMETERS as unknown as ToolRegistration['parameters'],
		// Rerun only to continue a parked question; see the module documentation.
		replay: 'safe',
		execute(args, api, context): Promise<ToolExecutionResult> {
			return runInQuestionCall({ api, context }, () =>
				executeCall(args as JsonValue, api, context),
			);
		},
	};
	Object.defineProperty(registration, RESUME, { value: resume, enumerable: false });
	return registration;
}

/**
 * Continue a parked Code Mode execution with the answer to its question
 * (the question seam's case 2, `questions.ts`): the script runs again over
 * its journal and the parked call takes `answer`. `registration` is the
 * current render's `codemode` tool. Returns the tool result of the continued
 * run, which may itself be parked on the next question. Call it inside the
 * agent's Durable Object.
 */
export function resumeCodemodeQuestion(
	registration: ToolRegistration,
	question: CodemodeApprovalQuestion,
	answer: FlueAnswer,
	api: ToolExecutionApi,
	context: Context,
): Promise<ToolExecutionResult> {
	const resume = (registration as { [RESUME]?: Resume })[RESUME];
	if (!resume) {
		return Promise.reject(
			new Error(
				`[flue] resumeCodemodeQuestion() needs the "${CODEMODE_TOOL_NAME}" tool registration.`,
			),
		);
	}
	return resume(question, answer, api, context);
}
