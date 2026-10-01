import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createBuilder } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MCP_AUTH_BINDING,
	MCP_AUTH_CLASS_NAME,
	scanCloudflareFeatures,
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

describe('Code Mode detection', () => {
	it('detects useCodeMode() and mcpOAuth() calls under the source root', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flue-codemode-scan-'));
		temporary.push(root);
		await writeFiles(root, {
			'agents/plain.ts': "'use agent';\nexport function Plain() { return 'hi'; }\n",
			'node_modules/dep/index.ts': 'useCodeMode({});\n',
			'types.d.ts': 'declare function useCodeMode(options: unknown): void;\n',
		});
		expect(await scanCloudflareFeatures(root)).toEqual({ codeMode: false, mcpOAuth: false });
		await writeFiles(root, {
			'hooks/tools.ts': 'export const useTools = () => useCodeMode ( { maxOutputTokens: 1 } );\n',
		});
		expect(await scanCloudflareFeatures(root)).toEqual({ codeMode: true, mcpOAuth: false });
		await writeFiles(root, {
			'mcp.ts':
				"export const auth = mcpOAuth({ principal: 'p', redirectUrl: 'https://a.test/cb' });\n",
		});
		expect(await scanCloudflareFeatures(root)).toMatchObject({ codeMode: true, mcpOAuth: true });
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

/** Build the same app for the Node target (no cloudflare() plugin). */
async function buildNodeFixture(agentSource: string): Promise<void> {
	const packageRoot = fileURLToPath(new URL('..', import.meta.url));
	const root = await fs.promises.mkdtemp(path.join(packageRoot, '.fixture-node-'));
	temporary.push(root);
	await writeFiles(root, {
		'package.json': JSON.stringify({
			name: 'flue-codemode-node-fixture',
			private: true,
			type: 'module',
		}),
		'src/app.ts': ["import { Hono } from 'hono';", 'export default new Hono();', ''].join('\n'),
		'src/agents/researcher.ts': agentSource,
	});
	const builder = await createBuilder({
		root,
		configFile: false,
		logLevel: 'silent',
		plugins: [flue()],
	});
	await builder.buildApp();
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
	it('bundles QuickJS as a compiled module for Code Mode, and leaves stdio out of the Worker', async () => {
		const output = await buildCloudflareFixture(
			[
				"'use agent';",
				"import { useCodeMode, useMcpConnection, useModel } from '@flue/runtime';",
				'',
				'export function Researcher() {',
				"\tuseModel('anthropic/claude-sonnet-4-6');",
				"\tuseMcpConnection({ name: 'docs', url: 'https://mcp.example.com/mcp' });",
				"\tuseCodeMode({ requiresApproval: ['mcp__docs__*'] });",
				"\treturn 'Answer from the docs.';",
				'}',
				'',
			].join('\n'),
		);

		// The MCP client is in the Worker, speaking 2026-07-28 only...
		expect(findings(output, /server\/discover/).length).toBeGreaterThan(0);
		// ...and so is Pi's Code Mode: its prelude, run by QuickJS from a wasm
		// module the build emits next to the Worker.
		expect(findings(output, /codemode-prelude\.js/).length).toBeGreaterThan(0);
		expect([...output.keys()].filter((file) => file.endsWith('.wasm'))).toHaveLength(1);
		// No Dynamic Workers: no executor, no runtime facet, no Worker Loader.
		expect(findings(output, /DynamicWorkerExecutor|cm_executions/)).toEqual([]);
		expect(
			[...output].some(
				([file, code]) =>
					/\.m?js$/.test(file) && /export\s*\{[^}]*\bCodemodeRuntime\b[^}]*\}/.test(code),
			),
		).toBe(false);
		// No stdio transport and no process spawner, anywhere.
		expect(findings(output, /cross-spawn/)).toEqual([]);
		expect(findings(output, /client\/dist\/stdio\.mjs/)).toEqual([]);
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

		const config = deployConfigOf(output);
		expect(config.worker_loaders ?? []).toEqual([]);
		const bindings =
			(config.durable_objects as { bindings?: { name: string; class_name: string }[] } | undefined)
				?.bindings ?? [];
		// No mcpOAuth() call, no OAuth binding.
		expect(bindings.map((binding) => binding.name)).not.toContain(MCP_AUTH_BINDING);
	}, 180_000);

	it('leaves Code Mode out of an app that does not use it', async () => {
		const output = await buildCloudflareFixture(
			[
				"'use agent';",
				"import { useModel } from '@flue/runtime';",
				'export function Researcher() {',
				"\tuseModel('anthropic/claude-sonnet-4-6');",
				"\treturn 'Hello.';",
				'}',
				'',
			].join('\n'),
		);
		// The sandbox's JavaScript is part of the runtime; the 640 KB QuickJS module is not.
		expect([...output.keys()].filter((file) => file.endsWith('.wasm'))).toEqual([]);
	}, 180_000);

	it('builds a Node app that calls useCodeMode()', async () => {
		await expect(
			buildNodeFixture(
				[
					"'use agent';",
					"import { useCodeMode, useModel } from '@flue/runtime';",
					'export function Researcher() {',
					"\tuseModel('anthropic/claude-sonnet-4-6');",
					'\tuseCodeMode();',
					"\treturn 'Hello.';",
					'}',
					'',
				].join('\n'),
			),
		).resolves.toBeUndefined();
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
});
