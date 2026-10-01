/**
 * MCP over stdio, a Node-only capability. `@flue/runtime/node` installs this
 * factory when it loads; the shared MCP client never imports the stdio
 * transport, so the process spawner it needs stays out of Worker bundles.
 */
import { setMcpStdioTransportFactory } from '../mcp.ts';

let installed = false;

/** Let `useMcpConnection({ transport: 'stdio', command })` start local server processes. */
export function installMcpStdioTransport(): void {
	if (installed) return;
	installed = true;
	setMcpStdioTransportFactory(async (definition) => {
		const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
		return new StdioClientTransport({
			command: definition.command,
			...(definition.args ? { args: definition.args } : {}),
			...(definition.env ? { env: definition.env } : {}),
			...(definition.cwd ? { cwd: definition.cwd } : {}),
			stderr: 'inherit',
		});
	});
}
