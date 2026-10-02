/**
 * What the Cloudflare target needs for MCP and Code Mode
 * (docs/cloudflare-native.md rules 6 and 7):
 *
 * - Code Mode (`useCodeMode()`) runs Pi's QuickJS sandbox in-process in the
 *   agent's Durable Object. workerd cannot compile WebAssembly at run time,
 *   so when a module under the source root calls the hook, the generated
 *   Worker entry imports `@flue/runtime/cloudflare/codemode`, which imports
 *   `quickjs-wasi/quickjs.wasm` as a compiled module at build time. It needs
 *   no binding and no wrangler change; apps that never call the hook do not
 *   ship the module.
 * - The `FlueMcpAuth` Durable Object: MCP OAuth keeps each principal's
 *   credentials in one, per authorization server. The customizer binds it as
 *   {@link MCP_AUTH_BINDING} when a module calls `mcpOAuth(`; its migration
 *   (`new_sqlite_classes: ["FlueMcpAuth"]`) belongs to the user's wrangler
 *   config like every other Durable Object class's.
 */
import * as fs from 'node:fs/promises';
import { glob } from 'tinyglobby';

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
	let codeMode = false;
	let mcpOAuth = false;
	for (const file of files.sort()) {
		const code = await fs.readFile(file, 'utf8').catch(() => '');
		codeMode ||= CODE_MODE_CALL.test(code);
		mcpOAuth ||= MCP_OAUTH_CALL.test(code);
		if (codeMode && mcpOAuth) break;
	}
	return { codeMode, mcpOAuth };
}

/** The `FlueMcpAuth` Durable Object binding, unless the config already declares it. */
export function mcpAuthBinding(): { name: string; class_name: string } {
	return { name: MCP_AUTH_BINDING, class_name: MCP_AUTH_CLASS_NAME };
}
