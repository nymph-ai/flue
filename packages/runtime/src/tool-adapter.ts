import type { ToolDefinition } from './tool-types.ts';

/** Model-facing tool result content: text, or a base64 image. */
export type PreparedToolContent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: string; readonly mimeType: string };

type PreparedToolAdapter = {
	readonly parameters: object;
	/**
	 * Run the tool. A string is one text block; an array is the result's
	 * content as is, so images reach the model as images.
	 */
	execute(
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string | readonly PreparedToolContent[]>;
};

const preparedToolAdapter = Symbol('flue.preparedToolAdapter');
const mcpToolSource = Symbol('flue.mcpToolSource');

type PreparedToolDefinition = ToolDefinition & {
	readonly [preparedToolAdapter]?: PreparedToolAdapter;
};

export function registerPreparedToolAdapter(
	tool: ToolDefinition,
	adapter: PreparedToolAdapter,
): void {
	Object.defineProperty(tool, preparedToolAdapter, {
		value: Object.freeze(adapter),
		enumerable: true,
	});
}

export function getPreparedToolAdapter(tool: ToolDefinition): PreparedToolAdapter | undefined {
	return (tool as PreparedToolDefinition)[preparedToolAdapter];
}

/**
 * Where an adapted MCP tool came from: its server and the server's own
 * `tools/list` entry, plus a call that returns the server's whole result.
 * Code Mode reads it to expose MCP servers as typed connectors (output
 * schemas, structured content and images intact) instead of as the text-only
 * tools the model calls directly.
 */
export interface McpToolSource {
	/** Declared server name. */
	readonly server: string;
	/** The server's instructions, when it sent any. */
	readonly instructions?: string;
	/** The server's `tools/list` entry, as listed. */
	readonly tool: {
		readonly name: string;
		readonly title?: string;
		readonly description?: string;
		readonly inputSchema: object;
		readonly outputSchema?: object;
	};
	/** Call the tool and resolve with the server's `CallToolResult`. */
	call(args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
}

/** The parts of an MCP `CallToolResult` Flue reads. */
export interface McpCallResult {
	readonly content?: readonly ({ readonly type: string } & Record<string, unknown>)[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
}

/** Record the MCP origin of an adapted tool (a definition or a Pi registration). */
export function registerMcpToolSource(target: object, source: McpToolSource): void {
	Object.defineProperty(target, mcpToolSource, { value: source, enumerable: false });
}

/** The MCP origin of an adapted tool, if it is one. */
export function getMcpToolSource(target: object): McpToolSource | undefined {
	return (target as { readonly [mcpToolSource]?: McpToolSource })[mcpToolSource];
}
