/**
 * `@flue/runtime/cloudflare/codemode`: Code Mode's runtime on Cloudflare
 * (docs/cloudflare-native.md rule 7). The generated Worker entry imports this
 * module when an agent calls `useCodeMode()`; it
 *
 * - re-exports `CodemodeRuntime`, `@cloudflare/codemode`'s Durable Object
 *   Facet class, so the Worker entry exports it and `ctx.exports` carries it;
 * - registers the Code Mode host: one runtime per agent, a facet named
 *   {@link CODEMODE_RUNTIME_NAME} under the agent's Durable Object
 *   (`ctx.facets.get("codemode:flue", …)`), with its own SQLite holding the
 *   execution log, pending approvals, step results and snippets;
 * - turns the codemode tool's connector specs into `@cloudflare/codemode`
 *   connectors: a `CodemodeConnector` for the agent's own tools and an
 *   `McpConnector` per MCP server, carrying `requiresApproval`.
 *
 * Scripts run in Dynamic Workers ({@link createCodemodeExecutor}): no
 * `fetch()`, no `connect()`; they reach the host only through the connectors,
 * over Workers RPC.
 *
 * Limits (Workers Paid, Dynamic Workers documentation, 2026-08):
 *
 * - A Durable Object can have at most 10 distinct Dynamic Workers with
 *   requests in flight; this executor runs at most {@link DEFAULT_CONCURRENCY}
 *   scripts at once per agent instance and queues the rest.
 * - `limits.cpuMs` bounds one script's CPU (the Workers Paid ceiling is
 *   5 minutes; scripts mostly wait on the host, so the default is 30 s).
 * - `limits.subRequests` bounds its subrequests. With no network, those are
 *   its RPC calls back to the host, so the default allows 1 000 tool calls.
 * - Each distinct (id, code) pair counts as a Dynamic Worker created that
 *   day for billing; a script is a new one every time.
 */
import {
	CodemodeConnector,
	type CodemodeRuntimeHandle,
	type ConnectorTool,
	type ConnectorTools,
	createCodemodeRuntime,
	DynamicWorkerExecutor,
	type Executor,
	type McpConnectionLike,
	McpConnector,
} from '@cloudflare/codemode';
import type { CodemodeExecutor } from '../codemode/executor.ts';
import {
	type CodemodeConnectorSpec,
	type CodemodeOutcome,
	type McpConnectorSpec,
	registerCodemodeHost,
	type ToolsConnectorSpec,
} from '../codemode/host.ts';
import { getCloudflareContext } from './context.ts';

export { CodemodeRuntime } from '@cloudflare/codemode';

/** The Worker Loader binding `@flue/vite` adds when an agent calls `useCodeMode()`. */
export const CODEMODE_LOADER_BINDING = 'LOADER';

/** The name of each agent's Code Mode runtime facet (`codemode:flue`). */
export const CODEMODE_RUNTIME_NAME = 'flue';

const DEFAULT_CPU_MS = 30_000;
const DEFAULT_SUBREQUESTS = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;

/** The Worker Loader binding (`env.LOADER`). */
export type CodemodeWorkerLoader = WorkerLoader;

export interface CodemodeExecutorOptions {
	/** The Worker Loader binding, `env.LOADER`. */
	readonly loader: CodemodeWorkerLoader;
	/** Wall-clock deadline for one script. Default 60 000 ms. */
	readonly timeoutMs?: number;
	/** CPU limit for one script's Dynamic Worker. Default 30 000 ms. */
	readonly cpuMs?: number;
	/** Subrequest limit (host calls included) for one script. Default 1 000. */
	readonly subRequests?: number;
	/** Scripts running at once in this isolate; the platform allows 10 per Durable Object. Default 4. */
	readonly concurrency?: number;
}

/**
 * A `DynamicWorkerExecutor` for `useCodeMode({ executor })`: no outbound
 * network, CPU and subrequest limits on every Dynamic Worker, and bounded
 * concurrency. `useCodeMode()` without an executor uses one over `env.LOADER`
 * with the defaults.
 */
export function createCodemodeExecutor(options: CodemodeExecutorOptions): CodemodeExecutor {
	const limits = {
		cpuMs: options.cpuMs ?? DEFAULT_CPU_MS,
		subRequests: options.subRequests ?? DEFAULT_SUBREQUESTS,
	};
	// `DynamicWorkerExecutor` has no `limits` option; the loader it is given
	// adds them to every Worker it loads.
	const loader: WorkerLoader = {
		load: (code) => options.loader.load({ ...code, limits: { ...limits, ...code.limits } }),
		get: (name, getCode) =>
			options.loader.get(name, async () => {
				const code = await getCode();
				return { ...code, limits: { ...limits, ...code.limits } };
			}),
	};
	const inner = new DynamicWorkerExecutor({
		loader,
		globalOutbound: null,
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});
	const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 10));
	let running = 0;
	const queue: (() => void)[] = [];
	return {
		async execute(code, providers, executeOptions) {
			if (running >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
			running += 1;
			try {
				return await inner.execute(code, providers, executeOptions);
			} finally {
				running -= 1;
				queue.shift()?.();
			}
		},
	};
}

/** One default executor per loader binding, so its concurrency bound is per isolate. */
const defaultExecutors = new WeakMap<object, CodemodeExecutor>();

function defaultExecutor(env: Record<string, unknown>): CodemodeExecutor {
	const loader = env[CODEMODE_LOADER_BINDING] as WorkerLoader | undefined;
	if (!loader || typeof loader.load !== 'function') {
		throw new Error(
			`[flue] useCodeMode() needs the Worker Loader binding "${CODEMODE_LOADER_BINDING}" (Dynamic Workers, Workers Paid). ` +
				'@flue/vite adds it when an agent module calls useCodeMode(); if you set the wrangler config yourself, add "worker_loaders": [{ "binding": "LOADER" }].',
		);
	}
	let executor = defaultExecutors.get(loader);
	if (!executor) {
		executor = createCodemodeExecutor({ loader });
		defaultExecutors.set(loader, executor);
	}
	return executor;
}

function agentState(): DurableObjectState {
	const state = getCloudflareContext().durableObjectState;
	if (!state) {
		throw new Error(
			"[flue] Code Mode runs inside the agent's Durable Object: its runtime is a Durable Object Facet of the agent, and no Durable Object state is in scope here.",
		);
	}
	const facets = (state as { facets?: unknown }).facets;
	const exports = (state as { exports?: { CodemodeRuntime?: unknown } }).exports;
	if (!facets) {
		throw new Error(
			'[flue] Code Mode needs Durable Object Facets (ctx.facets), which this workerd does not provide. Update wrangler / @cloudflare/vite-plugin.',
		);
	}
	if (!exports?.CodemodeRuntime) {
		throw new Error(
			'[flue] Code Mode needs the CodemodeRuntime facet class in ctx.exports: the Worker entry must export it (the entry @flue/vite generates does when an agent calls useCodeMode(); a custom `main` must `export * from "virtual:flue/worker"` or `export { CodemodeRuntime } from "@flue/runtime/cloudflare/codemode"`), ' +
				'and ctx.exports must not be disabled (no "disable_ctx_exports" compatibility flag).',
		);
	}
	return state;
}

class FlueToolsConnector extends CodemodeConnector {
	constructor(
		state: DurableObjectState,
		private readonly spec: ToolsConnectorSpec,
	) {
		super(state, {});
	}

	name(): string {
		return this.spec.name;
	}

	protected override instructions(): string {
		return "This agent's own tools.";
	}

	protected tools(): ConnectorTools {
		const tools: ConnectorTools = {};
		for (const method of this.spec.methods) {
			tools[method.id] = {
				...(method.description ? { description: method.description } : {}),
				inputSchema: method.inputSchema as ConnectorTool['inputSchema'],
				...(method.requiresApproval ? { requiresApproval: true } : {}),
				execute: (args: unknown) => method.execute(args),
			};
		}
		return tools;
	}
}

class FlueMcpConnector extends McpConnector {
	readonly #byToolName: Map<string, McpConnectorSpec['methods'][number]>;

	constructor(
		state: DurableObjectState,
		private readonly spec: McpConnectorSpec,
	) {
		super(state, {});
		this.#byToolName = new Map(spec.methods.map((method) => [method.toolName, method]));
	}

	name(): string {
		return this.spec.name;
	}

	protected createConnection(): McpConnectionLike {
		return {
			name: this.spec.name,
			...(this.spec.instructions ? { instructions: this.spec.instructions } : {}),
			client: {
				callTool: async ({ name, arguments: args }) =>
					(await this.spec.call(name, args ?? {})) as never,
			},
			tools: this.spec.methods.map((method) => ({
				name: method.toolName,
				...(method.description ? { description: method.description } : {}),
				inputSchema: method.inputSchema as never,
				...(method.outputSchema ? { outputSchema: method.outputSchema as never } : {}),
			})),
		};
	}

	protected override toolName(tool: { name: string }): string {
		return this.#byToolName.get(tool.name)?.id ?? tool.name;
	}

	protected override tool(name: string, t: ConnectorTool): ConnectorTool {
		const method = this.spec.methods.find((candidate) => candidate.id === name);
		return method?.requiresApproval ? { ...t, requiresApproval: true } : t;
	}
}

function connectorFor(state: DurableObjectState, spec: CodemodeConnectorSpec): CodemodeConnector {
	return spec.kind === 'tools'
		? new FlueToolsConnector(state, spec)
		: new FlueMcpConnector(state, spec);
}

/**
 * The agent's Code Mode runtime, for curating what it keeps: the audit trail
 * of executions, pending approvals, and snippets. `saveSnippet(name, {
 * executionId })` promotes a run the model made (the codemode tool result's
 * details carry its `executionId`) to a script the model finds with
 * `codemode.search()` and re-runs with `codemode.run(name, input)`. Call it
 * inside the agent's Durable Object (a tool, a lifecycle hook).
 */
export function codemodeRuntime(): Pick<
	CodemodeRuntimeHandle,
	'executions' | 'pending' | 'saveSnippet' | 'snippets' | 'deleteSnippet'
> {
	const runtime = createCodemodeRuntime({
		ctx: agentState(),
		name: CODEMODE_RUNTIME_NAME,
		// Curation never runs code or reaches a connector.
		executor: {
			execute: () => Promise.reject(new Error('[flue] codemodeRuntime() runs no code.')),
		},
		connectors: [],
	});
	return {
		executions: (limit) => runtime.executions(limit),
		pending: (executionId) => runtime.pending(executionId),
		saveSnippet: (name, options) => runtime.saveSnippet(name, options),
		snippets: () => runtime.snippets(),
		deleteSnippet: (name) => runtime.deleteSnippet(name),
	};
}

registerCodemodeHost({
	runtimeName: CODEMODE_RUNTIME_NAME,
	open({ connectors, executor, wrapExecutor }) {
		const context = getCloudflareContext();
		const state = agentState();
		const runtime = createCodemodeRuntime({
			ctx: state,
			name: CODEMODE_RUNTIME_NAME,
			executor: wrapExecutor(executor ?? defaultExecutor(context.env)) as unknown as Executor,
			connectors: connectors.map((spec) => connectorFor(state, spec)),
		});
		return {
			execute: async (code) => (await runtime.execute({ code })) as CodemodeOutcome,
			approve: async (executionId) => (await runtime.approve({ executionId })) as CodemodeOutcome,
			async reject(executionId, seqs) {
				let terminated = false;
				for (const seq of seqs) {
					terminated = (await runtime.reject({ seq, executionId })) || terminated;
				}
				return terminated;
			},
		};
	},
});
