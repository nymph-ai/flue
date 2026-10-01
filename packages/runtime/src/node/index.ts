/**
 * Node-specific entry point for `@flue/runtime`. Exports the `local()`
 * sandbox factory for use in `useSandbox(local(...))`,
 * the built-in `sqlite()` persistence adapter, and the Code Mode executor
 * for `useCodeMode()` (a `node:vm` worker — trusted code only).
 *
 * Loading this entry also enables what only Node can do: MCP servers over
 * stdio (`useMcpConnection({ transport: 'stdio', command })`), and
 * `@cloudflare/codemode` (whose `cloudflare:workers` import Node answers
 * with a shim).
 *
 * Import platform-agnostic types (`FlueEventContext`, `PersistenceAdapter`, etc.)
 * from `@flue/runtime`.
 */
import { installCloudflareWorkersShim } from './cloudflare-workers-shim.ts';
import { installMcpStdioTransport } from './mcp-stdio.ts';

installMcpStdioTransport();
installCloudflareWorkersShim();

export { sqlite } from './agent-execution-store.ts';
export { NodeCodemodeExecutor, type NodeCodemodeExecutorOptions } from './codemode-node.ts';
export { type LocalSandboxOptions, local } from './local.ts';
export {
	type Flue,
	type StartAgentConfig,
	type StartAgentEntry,
	type StartOptions,
	start,
} from './start.ts';
