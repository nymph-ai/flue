/**
 * What the Cloudflare target needs for Pi-backed MCP and Code Mode
 * (PI_UPGRADE_PLAN.md §5, §6):
 *
 * - `worker_loaders`: `useCodeMode()` runs scripts in Dynamic Workers, which
 *   need a Worker Loader binding. The customizer adds {@link CODEMODE_LOADER_BINDING}
 *   when a module under the source root calls the hook. Dynamic Workers need
 *   the Workers Paid plan, so apps that never call it get no binding.
 * - Stubs for `cross-spawn` and `node:child_process`: `@flue/runtime` imports
 *   only `McpClient`, `StreamableHttpTransport` and `toLlmContent` from
 *   `@earendil-works/pi-mcp`, whose root also re-exports the stdio transport.
 *   `sideEffects: false` lets the bundler drop that transport; the aliases are
 *   the backstop, so a stdio import that survives fails with a clear error
 *   instead of dragging a process spawner into a Worker.
 */
import * as fs from 'node:fs/promises';
import { glob } from 'tinyglobby';
import type { Alias } from 'vite';

/** Matches `@flue/runtime`'s `CODEMODE_LOADER_BINDING`. */
export const CODEMODE_LOADER_BINDING = 'LOADER';

const CODE_MODE_CALL = /\buseCodeMode\s*\(/;

/** Whether any module under `sourceRoot` calls `useCodeMode(`. */
export async function scanCodeModeUsage(sourceRoot: string): Promise<boolean> {
	const files = await glob(['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'], {
		cwd: sourceRoot,
		absolute: true,
		ignore: ['**/node_modules/**', '**/*.d.ts', '**/*.d.mts', '**/*.d.cts'],
	});
	for (const file of files) {
		const code = await fs.readFile(file, 'utf8').catch(() => '');
		if (CODE_MODE_CALL.test(code)) return true;
	}
	return false;
}

/** Add the Worker Loader binding Code Mode uses, unless the config already declares it. */
export function mergeCodeModeLoaderBinding(config: Record<string, unknown>): void {
	const existing = Array.isArray(config.worker_loaders)
		? (config.worker_loaders as unknown[]).filter(
				(binding): binding is Record<string, unknown> =>
					typeof binding === 'object' && binding !== null,
			)
		: [];
	if (existing.some((binding) => binding.binding === CODEMODE_LOADER_BINDING)) return;
	config.worker_loaders = [...existing, { binding: CODEMODE_LOADER_BINDING }];
}

export const VIRTUAL_CROSS_SPAWN_STUB = 'virtual:flue/stub/cross-spawn';
export const VIRTUAL_CHILD_PROCESS_STUB = 'virtual:flue/stub/child-process';
export const RESOLVED_CROSS_SPAWN_STUB = `\0${VIRTUAL_CROSS_SPAWN_STUB}`;
export const RESOLVED_CHILD_PROCESS_STUB = `\0${VIRTUAL_CHILD_PROCESS_STUB}`;

/** `resolve.alias` entries for the Cloudflare target. */
export const CLOUDFLARE_STUB_ALIASES: Alias[] = [
	{ find: /^cross-spawn$/, replacement: VIRTUAL_CROSS_SPAWN_STUB },
	{ find: /^(?:node:)?child_process$/, replacement: VIRTUAL_CHILD_PROCESS_STUB },
];

const UNAVAILABLE = (what: string) =>
	`function unavailable() {\n\tthrow new Error(${JSON.stringify(
		`[flue] ${what} is not available in a Cloudflare Worker: Workers cannot start processes, so MCP stdio servers cannot run there. Connect to the server over Streamable HTTP instead.`,
	)});\n}\n`;

export const CROSS_SPAWN_STUB_SOURCE = `${UNAVAILABLE('cross-spawn')}unavailable.spawn = unavailable;
unavailable.sync = unavailable;
export const spawn = unavailable;
export const sync = unavailable;
export default unavailable;
`;

const CHILD_PROCESS_EXPORTS = [
	'spawn',
	'spawnSync',
	'exec',
	'execSync',
	'execFile',
	'execFileSync',
	'fork',
];

export const CHILD_PROCESS_STUB_SOURCE = `${UNAVAILABLE('node:child_process')}${CHILD_PROCESS_EXPORTS.map(
	(name) => `export const ${name} = unavailable;\n`,
).join('')}export class ChildProcess {
	constructor() {
		unavailable();
	}
}
export default { ${CHILD_PROCESS_EXPORTS.join(', ')}, ChildProcess };
`;
