/**
 * Where Code Mode's runtime comes from. `@cloudflare/codemode` imports
 * `cloudflare:workers` and keeps its durable state in a Durable Object Facet
 * of the agent (`ctx.facets`), so it exists only inside workerd. The shared
 * runtime never imports it: `@flue/runtime/cloudflare/codemode` (which the
 * generated Worker entry imports when an agent calls `useCodeMode()`)
 * registers a {@link CodemodeHost} built on it. On Node nothing registers
 * one, and Code Mode fails with {@link codemodeUnavailableError}.
 */
import type { McpToolAnnotations } from '../mcp-types.ts';
import type { CodemodePendingAction } from '../questions.ts';
import type { McpCallResult } from '../tool-adapter.ts';
import type { CodemodeExecutor } from './executor.ts';

/** One method of a sandbox namespace, as the approval policy sees it. */
export interface CodemodeMethod {
	/** Sandbox path, `<namespace>.<method>`. */
	readonly path: string;
	/** Sandbox namespace: `tools` for the agent's own tools, else one per MCP server. */
	readonly namespace: string;
	/** Method identifier inside the namespace. */
	readonly method: string;
	/** The Flue tool's name, or the MCP server's own tool name. */
	readonly tool: string;
	/** The MCP server, for MCP methods. */
	readonly server?: string;
	/** The MCP server's annotations for the tool (untrusted hints), when it sent any. */
	readonly annotations?: McpToolAnnotations;
}

interface MethodSpec {
	/** Identifier inside the namespace. */
	readonly id: string;
	readonly description?: string;
	readonly inputSchema: object;
	readonly outputSchema?: object;
	readonly requiresApproval: boolean;
}

/** The agent's own tools, one connector. */
export interface ToolsConnectorSpec {
	readonly kind: 'tools';
	readonly name: string;
	readonly methods: readonly (MethodSpec & { execute(args: unknown): Promise<unknown> })[];
}

/** One MCP server, one connector over its tool list. */
export interface McpConnectorSpec {
	readonly kind: 'mcp';
	readonly name: string;
	readonly instructions?: string;
	readonly methods: readonly (MethodSpec & { readonly toolName: string })[];
	/** Call one of the server's tools by its own name. */
	call(toolName: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

export type CodemodeConnectorSpec = ToolsConnectorSpec | McpConnectorSpec;

/** One connector call or step of an execution, as its log records it. */
export interface CodemodeLogEntry {
	readonly seq: number;
	readonly connector: string;
	readonly method: string;
	readonly state: string;
}

/** Where one pass of an execution ended (`@cloudflare/codemode`'s `ProxyToolOutput`). */
export type CodemodeOutcome =
	| {
			readonly status: 'completed';
			readonly executionId: string;
			readonly result: unknown;
			readonly logs?: readonly string[];
			readonly calls?: readonly CodemodeLogEntry[];
	  }
	| {
			readonly status: 'paused';
			readonly executionId: string;
			readonly pending: readonly CodemodePendingAction[];
			readonly calls?: readonly CodemodeLogEntry[];
	  }
	| {
			readonly status: 'error';
			readonly executionId: string;
			readonly error: string;
			readonly logs?: readonly string[];
			readonly calls?: readonly CodemodeLogEntry[];
	  };

/** The agent's Code Mode runtime with one call's connectors and executor. */
export interface CodemodeSession {
	/** Run a script as a new execution. */
	execute(code: string): Promise<CodemodeOutcome>;
	/** Approve the paused execution's pending actions and continue it by replay. */
	approve(executionId: string): Promise<CodemodeOutcome>;
	/** Reject the paused execution's pending actions, ending it. True when it was still paused. */
	reject(executionId: string, seqs: readonly number[]): Promise<boolean>;
}

export interface CodemodeHost {
	/** Name of the runtime facet: one per agent. */
	readonly runtimeName: string;
	/**
	 * Open the agent's runtime. `executor` is the declared one, or the host's
	 * default when absent; `wrapExecutor` lets the tool add globals to the
	 * `codemode` namespace.
	 */
	open(options: {
		readonly connectors: readonly CodemodeConnectorSpec[];
		readonly executor: CodemodeExecutor | undefined;
		readonly wrapExecutor: (executor: CodemodeExecutor) => CodemodeExecutor;
	}): CodemodeSession;
}

let host: CodemodeHost | undefined;

/** Install the host (`@flue/runtime/cloudflare/codemode` does, at import). */
export function registerCodemodeHost(next: CodemodeHost): void {
	host = next;
}

function codemodeUnavailableError(): Error {
	return new Error(
		'[flue] useCodeMode() runs only on the Cloudflare target: its runtime is `@cloudflare/codemode`, ' +
			'whose durable state (executions, approvals, steps, snippets) lives in a Durable Object Facet of the agent, ' +
			'and its scripts run in Dynamic Workers. Node has neither. Build the app for Cloudflare, or remove useCodeMode().',
	);
}

/** The registered host; throws on targets without one. */
export function requireCodemodeHost(): CodemodeHost {
	if (!host) throw codemodeUnavailableError();
	return host;
}
