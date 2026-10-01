/**
 * What the Cloudflare target needs for Pi-backed MCP and Code Mode
 * (PI_UPGRADE_PLAN.md §5, §6):
 *
 * - `worker_loaders`: `useCodeMode()` runs scripts in Dynamic Workers, which
 *   need a Worker Loader binding. The customizer adds {@link CODEMODE_LOADER_BINDING}
 *   when a module under the source root calls the hook. Dynamic Workers need
 *   the Workers Paid plan, so apps that never call it get no binding.
 * - A stub for `cross-spawn`: `@flue/runtime` imports only `McpClient`,
 *   `StreamableHttpTransport` and `toLlmContent` from `@earendil-works/pi-mcp`,
 *   whose root also re-exports the stdio transport. `sideEffects: false` lets
 *   the bundler drop that transport; the alias is the backstop, so a stdio
 *   import that survives fails with a clear error instead of bundling a
 *   process spawner into the Worker. `node:child_process` needs no alias:
 *   with `nodejs_compat` and a compatibility date from 2026-03-17 (Flue's
 *   floor is later) workerd itself provides it as a non-functional stub
 *   (`enable_nodejs_child_process_module`), and @cloudflare/vite-plugin leaves
 *   it external for workerd to supply.
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
export const RESOLVED_CROSS_SPAWN_STUB = `\0${VIRTUAL_CROSS_SPAWN_STUB}`;

/** `resolve.alias` entries for the Cloudflare target. */
export const CLOUDFLARE_STUB_ALIASES: Alias[] = [
	{ find: /^cross-spawn$/, replacement: VIRTUAL_CROSS_SPAWN_STUB },
];

export const CROSS_SPAWN_STUB_SOURCE = `function unavailable() {
	throw new Error(${JSON.stringify(
		'[flue] cross-spawn is not available in a Cloudflare Worker: Workers cannot start processes, so MCP stdio servers cannot run there. Connect to the server over Streamable HTTP instead.',
	)});
}
unavailable.spawn = unavailable;
unavailable.sync = unavailable;
export const spawn = unavailable;
export const sync = unavailable;
export default unavailable;
`;
