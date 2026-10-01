/**
 * What the Cloudflare target needs for MCP and Code Mode
 * (docs/cloudflare-native.md rules 6 and 7):
 *
 * - `worker_loaders`: `useCodeMode()` runs scripts in Dynamic Workers, which
 *   need a Worker Loader binding. The customizer adds {@link CODEMODE_LOADER_BINDING}
 *   when a module under the source root calls the hook. Dynamic Workers need
 *   the Workers Paid plan, so apps that never call it get no binding.
 * - The `FlueMcpAuth` Durable Object: MCP OAuth keeps each principal's
 *   credentials in one, per authorization server. The customizer binds it as
 *   {@link MCP_AUTH_BINDING} when a module calls `mcpOAuth(`; its migration
 *   (`new_sqlite_classes: ["FlueMcpAuth"]`) belongs to the user's wrangler
 *   config like every other Durable Object class's.
 * - A stub for `cross-spawn`: the MCP client's stdio transport lives on its
 *   own entry (`@modelcontextprotocol/client/stdio`) that only
 *   `@flue/runtime/node` imports, so no Worker bundle reaches it. The alias is
 *   the backstop: a stdio import that survives fails with a clear error
 *   instead of bundling a process spawner into the Worker. `node:child_process`
 *   needs no alias: with `nodejs_compat` and a compatibility date from
 *   2026-03-17 (Flue's floor is later) workerd itself provides it as a
 *   non-functional stub (`enable_nodejs_child_process_module`), and
 *   @cloudflare/vite-plugin leaves it external for workerd to supply.
 */
import * as fs from 'node:fs/promises';
import { glob } from 'tinyglobby';
import type { Alias } from 'vite';

/** Matches `@flue/runtime`'s `CODEMODE_LOADER_BINDING`. */
export const CODEMODE_LOADER_BINDING = 'LOADER';

/** Matches `@flue/runtime`'s `MCP_AUTH_BINDING` and `MCP_AUTH_CLASS_NAME`. */
export const MCP_AUTH_BINDING = 'FLUE_MCP_AUTH';
export const MCP_AUTH_CLASS_NAME = 'FlueMcpAuth';

const CODE_MODE_CALL = /\buseCodeMode\s*\(/;
const MCP_OAUTH_CALL = /\bmcpOAuth\s*\(/;

/** Which Cloudflare-specific features the modules under `sourceRoot` use. */
export async function scanCloudflareFeatures(
	sourceRoot: string,
): Promise<{ codeMode: boolean; mcpOAuth: boolean }> {
	const files = await glob(['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'], {
		cwd: sourceRoot,
		absolute: true,
		ignore: ['**/node_modules/**', '**/*.d.ts', '**/*.d.mts', '**/*.d.cts'],
	});
	const found = { codeMode: false, mcpOAuth: false };
	for (const file of files) {
		const code = await fs.readFile(file, 'utf8').catch(() => '');
		found.codeMode ||= CODE_MODE_CALL.test(code);
		found.mcpOAuth ||= MCP_OAUTH_CALL.test(code);
		if (found.codeMode && found.mcpOAuth) break;
	}
	return found;
}

/** Whether any module under `sourceRoot` calls `useCodeMode(`. */
export async function scanCodeModeUsage(sourceRoot: string): Promise<boolean> {
	return (await scanCloudflareFeatures(sourceRoot)).codeMode;
}

/** The `FlueMcpAuth` Durable Object binding, unless the config already declares it. */
export function mcpAuthBinding(): { name: string; class_name: string } {
	return { name: MCP_AUTH_BINDING, class_name: MCP_AUTH_CLASS_NAME };
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
