import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createBuilder } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CODEMODE_LOADER_BINDING,
	CROSS_SPAWN_STUB_SOURCE,
	MCP_AUTH_BINDING,
	MCP_AUTH_CLASS_NAME,
	mergeCodeModeLoaderBinding,
	scanCloudflareFeatures,
	scanCodeModeUsage,
} from './cloudflare-codemode.ts';
import { flueWorkerConfig } from './cloudflare-worker-config.ts';
import { flue } from './flue-plugin.ts';

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporary.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
	);
});

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(root, name);
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		await fs.promises.writeFile(file, content);
	}
}

async function readTree(dir: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for (const entry of await fs.promises.readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const file = path.join(entry.parentPath, entry.name);
		files.set(path.relative(dir, file), await fs.promises.readFile(file, 'utf8'));
	}
	return files;
}

describe('Code Mode detection and the Worker Loader binding', () => {
	it('detects useCodeMode() calls under the source root', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flue-codemode-scan-'));
		temporary.push(root);
		await writeFiles(root, {
			'agents/plain.ts': "'use agent';\nexport function Plain() { return 'hi'; }\n",
			'node_modules/dep/index.ts': 'useCodeMode({});\n',
			'types.d.ts': 'declare function useCodeMode(options: unknown): void;\n',
		});
		expect(await scanCodeModeUsage(root)).toBe(false);
		await writeFiles(root, {
			'hooks/tools.ts': 'export const useTools = () => useCodeMode ( { executor } );\n',
		});
		expect(await scanCodeModeUsage(root)).toBe(true);
		expect((await scanCloudflareFeatures(root)).mcpOAuth).toBe(false);
		await writeFiles(root, {
			'mcp.ts':
				"export const auth = mcpOAuth({ principal: 'p', redirectUrl: 'https://a.test/cb' });\n",
		});
		expect(await scanCloudflareFeatures(root)).toEqual({ codeMode: true, mcpOAuth: true });
	});

	it('adds the LOADER binding once, keeping user worker loaders', () => {
		const config: Record<string, unknown> = { worker_loaders: [{ binding: 'OTHER' }] };
		mergeCodeModeLoaderBinding(config);
		mergeCodeModeLoaderBinding(config);
		expect(config.worker_loaders).toEqual([
			{ binding: 'OTHER' },
			{ binding: CODEMODE_LOADER_BINDING },
		]);
	});

	it('the cross-spawn stub fails with a clear error when called', async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flue-codemode-stubs-'));
		temporary.push(dir);
		const file = path.join(dir, 'cross-spawn.mjs');
		await fs.promises.writeFile(file, CROSS_SPAWN_STUB_SOURCE);
		const crossSpawn = await import(/* @vite-ignore */ pathToFileURL(file).href);
		expect(() => crossSpawn.default('node')).toThrow(
			/cross-spawn is not available in a Cloudflare Worker/,
		);
		expect(() => crossSpawn.sync('node')).toThrow(/Streamable HTTP/);
	});
});

/**
 * Build a Flue Cloudflare app with @flue/vite and @cloudflare/vite-plugin and
 * return the files it emits. The fixture lives inside this package so it
 * resolves @flue/runtime, hono and the Agents SDK through its node_modules.
 */
async function buildCloudflareFixture(
	agentSource: string,
	migrationClasses: readonly string[] = [],
): Promise<Map<string, string>> {
	const packageRoot = fileURLToPath(new URL('..', import.meta.url));
	const root = await fs.promises.mkdtemp(path.join(packageRoot, '.fixture-cloudflare-'));
	temporary.push(root);
	await writeFiles(root, {
		'package.json': JSON.stringify({
			name: 'flue-codemode-fixture',
			private: true,
			type: 'module',
		}),
		'wrangler.jsonc': JSON.stringify({
			name: 'codemode-fixture',
			compatibility_date: '2026-06-01',
			compatibility_flags: ['nodejs_compat'],
			migrations: [{ tag: 'v1', new_sqlite_classes: ['FlueResearcherAgent', ...migrationClasses] }],
		}),
		'src/app.ts': [
			"import { createAgentRouter } from '@flue/runtime/routing';",
			"import { Hono } from 'hono';",
			"import { Researcher } from './agents/researcher.ts';",
			'const app = new Hono();',
			"app.route('/agents/researcher', createAgentRouter(Researcher));",
			'export default app;',
			'',
		].join('\n'),
		'src/agents/researcher.ts': agentSource,
	});
	// `vite build` runs the environment builder when the config has one, which
	// is how @cloudflare/vite-plugin builds the Worker environment.
	const builder = await createBuilder({
		root,
		configFile: false,
		logLevel: 'silent',
		plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
	});
	await builder.buildApp();
	return readTree(path.join(root, 'dist'));
}

/** Every match of `pattern` in the emitted scripts, with its chunk's source modules and surroundings. */
function findings(output: Map<string, string>, pattern: RegExp) {
	return [...output]
		.filter(([file]) => /\.(?:m?js)$/.test(file))
		.flatMap(([file, code]) =>
			[...code.matchAll(new RegExp(pattern.source, 'g'))].map((match) => {
				// rolldown heads each source module's code with `//#region <path>`;
				// an import at the top of a chunk precedes them all, so it belongs
				// to the chunk's modules as a whole.
				const before = [...code.slice(0, match.index).matchAll(/\/\/#region (\S+)/g)].at(-1)?.[1];
				const modules = before
					? [before]
					: [...new Set([...code.matchAll(/\/\/#region (\S+)/g)].map((region) => region[1] ?? ''))];
				return {
					file,
					modules,
					context: code.slice(Math.max(0, match.index - 80), match.index + 60),
				};
			}),
		);
}

function deployConfigOf(output: Map<string, string>): Record<string, unknown> {
	const entry = [...output].find(([file]) => path.basename(file) === 'wrangler.json');
	if (!entry)
		throw new Error(`No wrangler.json in the build output: ${[...output.keys()].join(', ')}`);
	return JSON.parse(entry[1]);
}

describe('Cloudflare Worker bundle', () => {
	it('keeps the MCP stdio transport and cross-spawn out of the Worker and adds the Worker Loader binding', async () => {
		const output = await buildCloudflareFixture(
			[
				"'use agent';",
				"import { useCodeMode, useMcpConnection, useModel } from '@flue/runtime';",
				"import { createCodemodeExecutor } from '@flue/runtime/cloudflare';",
				"import { env } from 'cloudflare:workers';",
				'',
				'export function Researcher() {',
				"\tuseModel('anthropic/claude-sonnet-4-6');",
				"\tuseMcpConnection({ name: 'docs', url: 'https://mcp.example.com/mcp' });",
				'\tuseCodeMode({ executor: createCodemodeExecutor({ loader: env.LOADER }) });',
				"\treturn 'Answer from the docs.';",
				'}',
				'',
			].join('\n'),
		);

		// The MCP client is in the Worker (the coordinator's connection cache),
		// speaking the 2026-07-28 protocol...
		expect(findings(output, /server\/discover/).length).toBeGreaterThan(0);
		// ...and so is Code Mode's Dynamic Worker executor.
		expect(findings(output, /DynamicWorkerExecutor|globalOutbound/).length).toBeGreaterThan(0);
		// The stdio transport, with the process spawner, is not.
		expect(findings(output, /cross-spawn/)).toEqual([]);
		expect(findings(output, /StdioClientTransport/)).toEqual([]);
		expect(findings(output, /@modelcontextprotocol\/client\/stdio/)).toEqual([]);
		// `node:child_process` imports exist only in @anthropic-ai/sdk's Node-only
		// entries (agent-toolset/node, internal/node), which pi-ai reaches through
		// a dynamic import and workerd satisfies with its built-in stub. Nothing
		// else — the MCP client and Code Mode included — may import it.
		const childProcess = findings(output, /["'`](?:node:)?child_process["'`]/);
		expect(
			childProcess.filter(
				({ modules }) => !modules.every((module) => module.includes('/@anthropic-ai/sdk/')),
			),
		).toEqual([]);
		// Nor the Node executor (a node:vm host) or its cloudflare:workers shim.
		expect(findings(output, /NodeCodemodeExecutor|registerHooks/)).toEqual([]);

		const config = deployConfigOf(output);
		expect(config.worker_loaders).toEqual([{ binding: CODEMODE_LOADER_BINDING }]);
		// No mcpOAuth() call: no OAuth Durable Object binding.
		const bindings =
			(config.durable_objects as { bindings?: { name: string }[] } | undefined)?.bindings ?? [];
		expect(bindings.map((binding) => binding.name)).not.toContain(MCP_AUTH_BINDING);
	}, 180_000);

	it('binds the FlueMcpAuth Durable Object when an agent uses MCP OAuth', async () => {
		const source = [
			"'use agent';",
			"import { mcpOAuth, useMcpConnection, useModel } from '@flue/runtime';",
			'',
			'export function Researcher() {',
			"\tuseModel('anthropic/claude-sonnet-4-6');",
			"\tuseMcpConnection({ name: 'docs', url: 'https://mcp.example.com/mcp', auth: mcpOAuth({ principal: 'user', redirectUrl: 'https://app.example.com/__flue/mcp/oauth/callback' }) });",
			"\treturn 'Answer from the docs.';",
			'}',
			'',
		].join('\n');
		await expect(buildCloudflareFixture(source)).rejects.toThrow(
			/new_sqlite_classes.*FlueMcpAuth/s,
		);
		const output = await buildCloudflareFixture(source, [MCP_AUTH_CLASS_NAME]);
		const config = deployConfigOf(output);
		const bindings =
			(config.durable_objects as { bindings?: { name: string; class_name: string }[] }).bindings ??
			[];
		expect(bindings).toContainEqual({ name: MCP_AUTH_BINDING, class_name: MCP_AUTH_CLASS_NAME });
		// The class is exported from the Worker, and the callback route is served.
		expect(findings(output, /\/__flue\/mcp\/oauth\/callback/).length).toBeGreaterThan(0);
	}, 180_000);

	it('aliases a surviving cross-spawn import to the throwing stub', async () => {
		// cross-spawn is not installed where the fixture resolves from: only the
		// alias lets this build succeed.
		const output = await buildCloudflareFixture(
			[
				"'use agent';",
				"import { useModel } from '@flue/runtime';",
				"import spawn from 'cross-spawn';",
				'',
				'export function Researcher() {',
				"\tuseModel('anthropic/claude-sonnet-4-6');",
				"\tif (Math.random() > 2) spawn('node');",
				"\treturn 'No processes here.';",
				'}',
				'',
			].join('\n'),
		);
		expect(
			findings(output, /cross-spawn is not available in a Cloudflare Worker/).length,
		).toBeGreaterThan(0);
		// No useCodeMode() in this app: no Worker Loader binding.
		expect(deployConfigOf(output).worker_loaders ?? []).toEqual([]);
	}, 180_000);
});
