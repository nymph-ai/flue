/**
 * What the Cloudflare target needs for MCP and Code Mode
 * (docs/cloudflare-native.md rules 6 and 7):
 *
 * - Code Mode (`useCodeMode()`) is `@cloudflare/codemode`'s runtime, a
 *   Durable Object Facet of each agent, and runs scripts in Dynamic Workers.
 *   When a module under the source root calls the hook:
 *   - the customizer adds the `LOADER` Worker Loader binding (Dynamic
 *     Workers need the Workers Paid plan, so apps that never call it get
 *     none);
 *   - the generated Worker entry exports `CodemodeRuntime`, the facet class:
 *     facets are created from `ctx.exports`, so the class must be a
 *     top-level export. A facet-only class takes no Durable Object binding
 *     and no migration of its own;
 *   - the wrangler config must leave `ctx.exports` on (no
 *     `disable_ctx_exports`; it is on by default from 2025-11-17, below
 *     Flue's compatibility floor) and declare every agent class as
 *     SQLite-backed (`new_sqlite_classes`): a facet's supervisor must be.
 *   The Node target has neither facets nor Dynamic Workers, so a Node build
 *   of an app that calls `useCodeMode()` fails.
 * - The `FlueMcpAuth` Durable Object: MCP OAuth keeps each principal's
 *   credentials in one, per authorization server. The customizer binds it as
 *   {@link MCP_AUTH_BINDING} when a module calls `mcpOAuth(`; its migration
 *   (`new_sqlite_classes: ["FlueMcpAuth"]`) belongs to the user's wrangler
 *   config like every other Durable Object class's.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'tinyglobby';
import { stackless } from './diagnostics.ts';

/** Matches `@flue/runtime/cloudflare/codemode`'s `CODEMODE_LOADER_BINDING`. */
export const CODEMODE_LOADER_BINDING = 'LOADER';

/** `@cloudflare/codemode`'s facet class, exported by the generated Worker entry. */
export const CODEMODE_RUNTIME_CLASS_NAME = 'CodemodeRuntime';

/** Matches `@flue/runtime`'s `MCP_AUTH_BINDING` and `MCP_AUTH_CLASS_NAME`. */
export const MCP_AUTH_BINDING = 'FLUE_MCP_AUTH';
export const MCP_AUTH_CLASS_NAME = 'FlueMcpAuth';

const CODE_MODE_CALL = /\buseCodeMode\s*\(/;
const MCP_OAUTH_CALL = /\bmcpOAuth\s*\(/;

/** Which Cloudflare-specific features the modules under `sourceRoot` use. */
export async function scanCloudflareFeatures(
	sourceRoot: string,
): Promise<{ codeMode: boolean; mcpOAuth: boolean; codeModeFile?: string }> {
	const files = await glob(['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'], {
		cwd: sourceRoot,
		absolute: true,
		ignore: ['**/node_modules/**', '**/*.d.ts', '**/*.d.mts', '**/*.d.cts'],
	});
	let codeModeFile: string | undefined;
	let mcpOAuth = false;
	for (const file of files.sort()) {
		const code = await fs.readFile(file, 'utf8').catch(() => '');
		if (!codeModeFile && CODE_MODE_CALL.test(code)) codeModeFile = file;
		mcpOAuth ||= MCP_OAUTH_CALL.test(code);
		if (codeModeFile && mcpOAuth) break;
	}
	return { codeMode: codeModeFile !== undefined, mcpOAuth, ...(codeModeFile ? { codeModeFile } : {}) };
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

/**
 * Check the resolved wrangler config against what Code Mode's runtime facet
 * needs, failing with the exact change to make.
 */
export function assertCodeModeWorkerConfig(
	config: Record<string, unknown>,
	agentClassNames: readonly string[],
): void {
	const flags = Array.isArray(config.compatibility_flags) ? config.compatibility_flags : [];
	if (flags.includes('disable_ctx_exports')) {
		throw stackless(
			new Error(
				'[flue] An agent module calls useCodeMode(), whose runtime is a Durable Object Facet created from ctx.exports.CodemodeRuntime, ' +
					'but your wrangler config sets the "disable_ctx_exports" compatibility flag. Remove it from "compatibility_flags".',
			),
		);
	}
	const migrations = Array.isArray(config.migrations) ? (config.migrations as unknown[]) : [];
	const kvBacked = new Set<unknown>(
		migrations.flatMap((migration) => {
			const classes = (migration as { new_classes?: unknown } | null)?.new_classes;
			return Array.isArray(classes) ? classes : [];
		}),
	);
	const notSqlite = agentClassNames.filter((name) => kvBacked.has(name));
	if (notSqlite.length > 0) {
		throw stackless(
			new Error(
				`[flue] An agent module calls useCodeMode(), whose runtime is a Durable Object Facet of the agent, and a facet's parent must be SQLite-backed. ` +
					`Your wrangler config declares ${notSqlite.map((name) => `"${name}"`).join(', ')} under "new_classes" (key-value storage). ` +
					'Declare agent classes under "new_sqlite_classes" (a deployed key-value class cannot be converted: rename the class and add a new migration).',
			),
		);
	}
}

/** A Node build of an app that calls `useCodeMode()`. */
export function codeModeOnNodeError(root: string, file: string): Error {
	return stackless(
		new Error(
			`[flue] ${path.relative(root, file)} calls useCodeMode(), which runs only on the Cloudflare target: ` +
				"its runtime is @cloudflare/codemode's Durable Object Facet and its scripts run in Dynamic Workers, and Node has neither. " +
				'Build for Cloudflare (add cloudflare() from @cloudflare/vite-plugin after flue()), or remove useCodeMode().',
		),
	);
}
