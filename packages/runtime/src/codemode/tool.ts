/**
 * The `codemode` tool: one Pi Durable `ToolRegistration` over
 * `@cloudflare/codemode`'s runtime (docs/cloudflare-native.md rule 7). The
 * runtime is a Durable Object Facet of the agent — one per agent — which
 * owns the execution log, pending approvals, `codemode.step()` results and
 * snippets in its own SQLite; scripts run in Dynamic Workers with no network.
 *
 * This module only supplies what the runtime cannot know:
 *
 * - the connectors: `tools` for the agent's own Flue tools, and one
 *   `McpConnector` per MCP server, with `requiresApproval` set from the
 *   render's `useCodeMode({ requiresApproval })`;
 * - `codemode.store(key, value)` / `codemode.load(key)`, JSON values kept per
 *   conversation in a Pi document ({@link FlueCodemodeStore}) — the runtime
 *   has no conversation-scoped store of its own;
 * - what happens when an execution pauses for approval: the question seam
 *   (`questions.ts`).
 *
 * Nested calls have effects, so an interrupted script is never rerun. The
 * tool is registered `replay: "safe"` only so that a call parked on a
 * question survives an eviction (`pi/questions.ts`): Pi reruns it, and the
 * rerun continues the parked execution in the facet instead of starting the
 * script again; a rerun of a call that had not parked settles as
 * interrupted, as `replay: "unsafe"` would. The paused execution itself
 * lives in the facet and is continued like {@link resumeCodemodeQuestion}
 * does.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import type {
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from '@earendil-works/pi-durable';
import { fnv1a64 } from '../fnv.ts';
import { toModelContent } from '../mcp.ts';
import { beginQuestionableCall, cancelQuestion } from '../pi/questions.ts';
import {
	askQuestion,
	type CodemodeApprovalQuestion,
	currentQuestionCall,
	type FlueAnswer,
	QuestionParkedError,
	runInQuestionCall,
} from '../questions.ts';
import { getMcpToolSource, type McpToolSource } from '../tool-adapter.ts';
import type { CodemodeExecutor, CodemodeProvider } from './executor.ts';
import {
	type CodemodeConnectorSpec,
	type CodemodeMethod,
	type CodemodeOutcome,
	type CodemodeSession,
	requireCodemodeHost,
} from './host.ts';
import { FlueCodemodeStore } from './store.ts';

export const CODEMODE_TOOL_NAME = 'codemode';

/** The namespace of the agent's own tools. */
export const AGENT_TOOLS_NAMESPACE = 'tools';

/** Default token budget for the script's output. */
export const DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS = 10_000;

const MAX_CODE_LENGTH = 1_000_000;
const MAX_STORE_VALUE_BYTES = 256 * 1024;

export interface CodemodeToolOptions {
	/**
	 * Tools the script may call: the render's tools and MCP tools. An MCP
	 * tool joins its server's namespace; a tool named `codemode` is left out.
	 */
	readonly tools: readonly ToolRegistration[];
	/** `useCodeMode({ requiresApproval })`. */
	readonly requiresApproval?: readonly string[] | ((method: CodemodeMethod) => boolean);
	/** `useCodeMode({ executor })`; the host's default when absent. */
	readonly executor?: CodemodeExecutor;
	/** Output budget, in tokens (≈4 characters each). Default 10 000. */
	readonly maxOutputTokens?: number;
}

/** Details recorded on the codemode tool result. */
export interface CodemodeToolDetails {
	readonly executionId: string;
	readonly status: CodemodeOutcome['status'] | 'parked' | 'rejected';
	readonly calls: { path: string; state: string }[];
	/** The question the execution waits on, when parked. */
	readonly questionId?: string;
}

const RESERVED = new Set([
	'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await',
	'codemode',
].flatMap((words) => words.split(' ')));

/** A JavaScript identifier for a name (letters, digits, `_` and `$`). */
function identifier(name: string): string {
	let id = name.replace(/[^A-Za-z0-9_$]/g, '_');
	if (!/^[A-Za-z_$]/.test(id)) id = `_${id}`;
	if (RESERVED.has(id)) id = `${id}_`;
	return id;
}

/**
 * Identifiers for a list of names: the plain identifier when no other name
 * maps to it, otherwise every colliding name gets a `_<hash>` suffix of its
 * original, so `get-user` and `get_user` stay two methods.
 */
function uniqueIdentifiers(names: readonly string[], taken: ReadonlySet<string> = new Set()) {
	const groups = new Map<string, string[]>();
	for (const name of names) {
		const id = identifier(name);
		groups.set(id, [...(groups.get(id) ?? []), name]);
	}
	const ids = new Map<string, string>();
	for (const [id, group] of groups) {
		for (const name of group) {
			ids.set(
				name,
				group.length > 1 || taken.has(id) ? `${id}_${fnv1a64(name).slice(0, 6)}` : id,
			);
		}
	}
	return ids;
}

type ApprovalPolicy = (method: CodemodeMethod) => boolean;

function approvalPolicy(option: CodemodeToolOptions['requiresApproval']): ApprovalPolicy {
	if (option === undefined) return () => false;
	if (typeof option === 'function') return (method) => option(method) === true;
	const paths = new Set(option);
	return (method) => paths.has(method.path) || paths.has(`${method.namespace}.*`);
}

/** The namespaces a set of Pi tools forms in the sandbox, without their executors. */
interface Catalog {
	readonly own: readonly { tool: ToolRegistration; method: CodemodeMethod }[];
	readonly servers: readonly {
		readonly namespace: string;
		readonly server: string;
		readonly instructions?: string;
		readonly sources: readonly { source: McpToolSource; method: CodemodeMethod }[];
	}[];
}

function buildCatalog(tools: readonly ToolRegistration[]): Catalog {
	const ownTools = tools.filter(
		(tool) => tool.name !== CODEMODE_TOOL_NAME && !getMcpToolSource(tool),
	);
	const ownIds = uniqueIdentifiers(ownTools.map((tool) => tool.name));
	const own = ownTools.map((tool) => {
		const id = ownIds.get(tool.name) as string;
		return {
			tool,
			method: {
				path: `${AGENT_TOOLS_NAMESPACE}.${id}`,
				namespace: AGENT_TOOLS_NAMESPACE,
				method: id,
				tool: tool.name,
			},
		};
	});
	const byServer = new Map<string, McpToolSource[]>();
	for (const tool of tools) {
		const source = getMcpToolSource(tool);
		if (!source) continue;
		byServer.set(source.server, [...(byServer.get(source.server) ?? []), source]);
	}
	const namespaces = uniqueIdentifiers([...byServer.keys()], new Set([AGENT_TOOLS_NAMESPACE]));
	const servers = [...byServer].map(([server, sources]) => {
		const namespace = namespaces.get(server) as string;
		const ids = uniqueIdentifiers(sources.map((source) => source.tool.name));
		const instructions = sources[0]?.instructions;
		return {
			namespace,
			server,
			...(instructions ? { instructions } : {}),
			sources: sources.map((source) => {
				const id = ids.get(source.tool.name) as string;
				return {
					source,
					method: {
						path: `${namespace}.${id}`,
						namespace,
						method: id,
						tool: source.tool.name,
						server,
						...(source.tool.annotations ? { annotations: source.tool.annotations } : {}),
					},
				};
			}),
		};
	});
	return { own, servers };
}

/** The model-facing description: the sandbox ABI and the namespaces, never the full catalog. */
function createCodemodeDescription(catalog: Catalog): string {
	const namespaces = [
		...(catalog.own.length > 0
			? [
					`- \`${AGENT_TOOLS_NAMESPACE}\` — this agent's own tools: ${catalog.own
						.slice(0, 40)
						.map(({ method }) => method.method)
						.join(
							', ',
						)}${catalog.own.length > 40 ? `, … (${catalog.own.length} in all)` : ''}`,
				]
			: []),
		...catalog.servers.map((entry) => {
			const hint = entry.instructions?.split('\n')[0]?.slice(0, 200);
			return `- \`${entry.namespace}\` — MCP server "${entry.server}", ${entry.sources.length} method${entry.sources.length === 1 ? '' : 's'}${hint ? `. ${hint}` : ''}`;
		}),
	];
	return [
		'Execute JavaScript in a sandbox with access to connector SDKs. Only what the script returns or logs comes back to you.',
		'',
		'Write an async arrow function: `async () => { const hits = await codemode.search("create issue"); return hits; }`. Plain JavaScript only.',
		'',
		'## Workflow',
		'1. `const matches = await codemode.search("short intent phrase");` — ranked methods and saved snippets.',
		'2. `const docs = await codemode.describe(matches.results[0].path);` — TypeScript declarations.',
		'3. Call the method: `await <namespace>.<method>(input)` with one object argument.',
		'',
		'## Rules',
		'- Never guess method names or argument shapes: search, then describe.',
		'- `codemode.step(name, fn)` runs side-effectful or nondeterministic work (random, time) once and replays its result on resume. Everything else outside method calls must be deterministic.',
		'- `codemode.run(name, input)` runs a saved snippet; snippets appear in search results.',
		'- `codemode.store(key, value)` / `codemode.load(key)` keep JSON values across codemode calls in this conversation. Writes are kept only when the script completes; storing `undefined` deletes.',
		'- Some methods require approval. The script pauses there and resumes on its own once a person answers: write code as if the call returns normally. If the result says the execution is paused, tell the user what is pending and do NOT run the code again.',
		'- Await method calls one at a time (no `Promise.all` over methods): a resumed run replays calls in order.',
		"- An MCP method returns the server's structured result when it declares one; text comes back as a string (parsed when it is JSON); anything else, images included, as the whole result `{ content: [...] }`. To show yourself an image, return content blocks.",
		'- No network (`fetch`), filesystem, timers or Node APIs: everything goes through the namespaces.',
		'',
		'## Namespaces',
		...(namespaces.length > 0 ? namespaces : ['- (none)']),
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

/** One call of the tool (a script, or the continuation of a paused one). */
interface Invocation {
	readonly session: CodemodeSession;
	/** Commit the buffered `codemode.store()` writes. */
	commit(): Promise<void>;
}

const RESUME = Symbol('flue.codemode.resume');

type Resume = (
	question: CodemodeApprovalQuestion,
	answer: FlueAnswer,
	api: ToolExecutionApi,
	context: Context,
) => Promise<ToolExecutionResult>;

export function createCodemodeToolRegistration(options: CodemodeToolOptions): ToolRegistration {
	const host = requireCodemodeHost();
	const offered = options.tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
	const catalog = buildCatalog(offered);
	const requiresApproval = approvalPolicy(options.requiresApproval);
	const maxChars = (options.maxOutputTokens ?? DEFAULT_CODEMODE_MAX_OUTPUT_TOKENS) * 4;

	const open = async (api: ToolExecutionApi, context: Context): Promise<Invocation> => {
		let nested = 0;
		const runFlueTool = async (tool: ToolRegistration, input: unknown): Promise<unknown> => {
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

		const connectors: CodemodeConnectorSpec[] = [];
		if (catalog.own.length > 0) {
			connectors.push({
				kind: 'tools',
				name: AGENT_TOOLS_NAMESPACE,
				methods: catalog.own.map(({ tool, method }) => ({
					id: method.method,
					description: tool.description,
					inputSchema: tool.parameters as object,
					requiresApproval: requiresApproval(method),
					execute: (args: unknown) => runFlueTool(tool, args),
				})),
			});
		}
		// An MCP server's input_required inside a script is asked from this call.
		const questionCall = currentQuestionCall();
		for (const entry of catalog.servers) {
			const byName = new Map(entry.sources.map(({ source }) => [source.tool.name, source]));
			connectors.push({
				kind: 'mcp',
				name: entry.namespace,
				...(entry.instructions ? { instructions: entry.instructions } : {}),
				methods: entry.sources.map(({ source, method }) => ({
					id: method.method,
					toolName: source.tool.name,
					...(source.tool.description ? { description: source.tool.description } : {}),
					inputSchema: source.tool.inputSchema,
					...(source.tool.outputSchema ? { outputSchema: source.tool.outputSchema } : {}),
					requiresApproval: requiresApproval(method),
				})),
				call: (toolName, args) => {
					const source = byName.get(toolName);
					if (!source) throw new Error(`Unknown method ${entry.namespace}.${toolName}.`);
					const call = () => source.call(args, context.abortSignal);
					return questionCall ? runInQuestionCall(questionCall, call) : call();
				},
			});
		}

		// codemode.store()/load(): a per-conversation Pi document, written only
		// when an execution completes.
		const stored =
			(await api.snapshot(FlueCodemodeStore, api.conversationId, context))?.values ?? {};
		const writes = new Map<string, JsonValue | undefined>();
		const storeFns: CodemodeProvider['fns'] = {
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
		};
		const wrapExecutor = (executor: CodemodeExecutor): CodemodeExecutor => ({
			execute: (code, providers, executeOptions) =>
				executor.execute(
					code,
					providers.map((provider) =>
						provider.name === 'codemode'
							? { ...provider, fns: { ...provider.fns, ...storeFns } }
							: provider,
					),
					executeOptions,
				),
		});

		const session = host.open({ connectors, executor: options.executor, wrapExecutor });
		return {
			session,
			async commit() {
				if (writes.size === 0) return;
				await api.commit(async (tx) => {
					const doc = await tx.doc(FlueCodemodeStore, api.conversationId);
					for (const [key, value] of writes) {
						if (value === undefined) delete doc.values[key];
						else doc.values[key] = value as never;
					}
				}, context);
			},
		};
	};

	/** Carry an execution from its last pass to a result, asking whenever it pauses. */
	const settle = async (
		invocation: Invocation,
		first: CodemodeOutcome,
		api: ToolExecutionApi,
		context: Context,
		started: number,
	): Promise<ToolExecutionResult> => {
		let outcome = first;
		const signal = context.abortSignal;
		for (;;) {
			const wallTime = ((performance.now() - started) / 1000).toFixed(1);
			const calls = (outcome.calls ?? []).map((entry) => ({
				path: `${entry.connector}.${entry.method}`,
				state: entry.state,
			}));
			const details = (status: CodemodeToolDetails['status'], questionId?: string) =>
				({
					executionId: outcome.executionId,
					status,
					calls,
					...(questionId ? { questionId } : {}),
				}) satisfies CodemodeToolDetails as unknown as JsonValue;
			const logs =
				outcome.status !== 'paused' && outcome.logs?.length
					? `\nConsole:\n${clip(outcome.logs.join('\n'), maxChars)}`
					: '';

			if (outcome.status === 'completed') {
				await invocation.commit();
				const header: Content = [
					{ type: 'text', text: `Script completed (${wallTime}s).${logs}` },
				];
				const blocks = contentBlocks(outcome.result);
				const body: Content = blocks
					? toModelContent({ content: blocks }).map((block) =>
							block.type === 'text'
								? { type: 'text' as const, text: clip(block.text, maxChars) }
								: block,
						)
					: [{ type: 'text', text: clip(serialize(outcome.result), maxChars) }];
				return { content: [...header, ...body], details: details('completed') };
			}

			if (outcome.status === 'error') {
				const applied = calls.filter((call) => call.state === 'applied').map((call) => call.path);
				const made =
					applied.length > 0
						? `\nCalls made before the failure (not undone): ${applied.join(', ')}`
						: '';
				return {
					content: [
						{
							type: 'text',
							text: `Script failed (${wallTime}s): ${outcome.error}${made}${logs}`,
						},
					],
					details: details('error'),
					isError: true,
				};
			}

			const pending = outcome.pending;
			const question: CodemodeApprovalQuestion = {
				kind: 'codemode-approval',
				id: `codemode:${host.runtimeName}:${outcome.executionId}:${pending.map((action) => action.seq).join(',')}`,
				runtime: host.runtimeName,
				executionId: outcome.executionId,
				pending,
				conversationId: String(api.conversationId),
				callId: api.callId,
			};
			const waitingOn = pending.map((action) => `${action.connector}.${action.method}`).join(', ');
			let answer: FlueAnswer;
			try {
				answer = await askQuestion(question, signal);
			} catch (error) {
				if (error instanceof QuestionParkedError) {
					return {
						content: [
							{
								type: 'text',
								text: `Execution ${outcome.executionId} is paused: ${waitingOn} needs approval (question ${question.id}). It resumes on its own once answered; do not run the code again.`,
							},
						],
						details: details('parked', question.id),
					};
				}
				await invocation.session.reject(
					outcome.executionId,
					pending.map((action) => action.seq),
				);
				return {
					content: [
						{
							type: 'text',
							text: `Script stopped at ${waitingOn}, which needs approval: ${error instanceof Error ? error.message : String(error)} The execution was ended; calls before it were not undone.`,
						},
					],
					details: details('rejected', question.id),
					isError: true,
				};
			}
			const next = await apply(invocation, question, answer);
			if (next.kind === 'rejected') return next.result(details);
			outcome = next.outcome;
		}
	};

	/** Apply an answer to a paused execution. */
	const apply = async (
		invocation: Invocation,
		question: CodemodeApprovalQuestion,
		answer: FlueAnswer,
	): Promise<
		| { kind: 'continued'; outcome: CodemodeOutcome }
		| {
				kind: 'rejected';
				result: (
					details: (status: CodemodeToolDetails['status'], questionId?: string) => JsonValue,
				) => ToolExecutionResult;
		  }
	> => {
		if (answer.kind !== 'codemode-approval') {
			throw new Error(`[flue] ${question.id} needs a codemode-approval answer.`);
		}
		if (answer.decision === 'approve') {
			return { kind: 'continued', outcome: await invocation.session.approve(question.executionId) };
		}
		await invocation.session.reject(
			question.executionId,
			question.pending.map((action) => action.seq),
		);
		const waitingOn = question.pending
			.map((action) => `${action.connector}.${action.method}`)
			.join(', ');
		return {
			kind: 'rejected',
			result: (details) => ({
				content: [
					{
						type: 'text',
						text: `The approval of ${waitingOn} was rejected${answer.reason ? `: ${answer.reason}` : '.'} The execution ended there; calls before it were not undone.`,
					},
				],
				details: details('rejected', question.id),
				isError: true,
			}),
		};
	};

	const resume: Resume = async (question, answer, api, context) => {
		const started = performance.now();
		const invocation = await open(api, context);
		const next = await apply(invocation, question, answer);
		if (next.kind === 'rejected') {
			return next.result(
				(status, questionId) =>
					({
						executionId: question.executionId,
						status,
						calls: [],
						...(questionId ? { questionId } : {}),
					}) satisfies CodemodeToolDetails as unknown as JsonValue,
			);
		}
		return settle(invocation, next.outcome, api, context, started);
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
		if (code.length > MAX_CODE_LENGTH) {
			return {
				content: [{ type: 'text', text: 'The script is too large (over 1 MB).' }],
				isError: true,
			};
		}
		const started = performance.now();
		const begun = await beginQuestionableCall(api, context);
		if (begun.kind === 'resume' && begun.question.kind === 'codemode-approval') {
			// Pi reran a call parked on an approval: continue that execution.
			const invocation = await open(api, context);
			const paused: CodemodeOutcome = {
				status: 'paused',
				executionId: begun.question.executionId,
				pending: begun.question.pending,
			};
			return settle(invocation, paused, api, context, started);
		}
		if (begun.kind !== 'first') {
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
		}
		const invocation = await open(api, context);
		const outcome = await raceAbort(invocation.session.execute(code), context.abortSignal);
		return settle(invocation, outcome, api, context, started);
	};

	const registration: ToolRegistration = {
		name: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription(catalog),
		parameters: PARAMETERS as unknown as ToolRegistration['parameters'],
		// Rerun only to continue a parked question; see the module documentation.
		replay: 'safe',
		execute(args, api, context): Promise<ToolExecutionResult> {
			return runInQuestionCall({ api, context }, () => executeCall(args, api, context));
		},
	};
	Object.defineProperty(registration, RESUME, { value: resume, enumerable: false });
	return registration;
}

/**
 * Continue a parked Code Mode execution with the answer to its question
 * (the question seam's case 2, `questions.ts`). `registration` is the
 * current render's `codemode` tool — it supplies the connectors and the
 * executor; the paused execution itself lives in the runtime facet. Returns
 * the tool result of the continued run, which may itself be parked on the
 * next approval. Call it inside the agent's Durable Object.
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
			new Error(`[flue] resumeCodemodeQuestion() needs the "${CODEMODE_TOOL_NAME}" tool registration.`),
		);
	}
	return resume(question, answer, api, context);
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
