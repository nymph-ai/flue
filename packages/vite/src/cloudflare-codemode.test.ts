import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createBuilder } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CHILD_PROCESS_STUB_SOURCE,
	CODEMODE_LOADER_BINDING,
	CROSS_SPAWN_STUB_SOURCE,
	mergeCodeModeLoaderBinding,
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
		await writeFiles(root, { 'hooks/tools.ts': 'export const useTools = () => useCodeMode ( { executor } );\n' });
		expect(await scanCodeModeUsage(root)).toBe(true);
	});

	it('adds the LOADER binding once, keeping user worker loaders', () => {
		const config: Record<string, unknown> = { worker_loaders: [{ binding: 'OTHER' }] };
		mergeCodeModeLoaderBinding(config);
		mergeCodeModeLoaderBinding(config);
		expect(config.worker_loaders).toEqual([{ binding: 'OTHER' }, { binding: CODEMODE_LOADER_BINDING }]);
	});

	it('stubs fail with a clear error when called', async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flue-codemode-stubs-'));
		temporary.push(dir);
		let count = 0;
		const load = async (source: string) => {
			const file = path.join(dir, `stub-${count++}.mjs`);
			await fs.promises.writeFile(file, source);
			return import(/* @vite-ignore */ pathToFileURL(file).href);
		};
		const crossSpawn = await load(CROSS_SPAWN_STUB_SOURCE);
		expect(() => crossSpawn.default('node')).toThrow(/cross-spawn is not available in a Cloudflare Worker/);
		const childProcess = await load(CHILD_PROCESS_STUB_SOURCE);
		expect(() => childProcess.spawn('node')).toThrow(/node:child_process is not available/);
		expect(() => new childProcess.ChildProcess()).toThrow(/Streamable HTTP/);
	});
});

describe('Cloudflare Worker bundle', () => {
	it(
		'keeps child_process and cross-spawn out of the Worker and adds the Worker Loader binding',
		async () => {
			// Inside the package, so the fixture resolves @flue/runtime, hono and
			// the Agents SDK through this package's node_modules.
			const packageRoot = fileURLToPath(new URL('..', import.meta.url));
			const root = await fs.promises.mkdtemp(path.join(packageRoot, '.fixture-cloudflare-'));
			temporary.push(root);
			await writeFiles(root, {
				'package.json': JSON.stringify({ name: 'flue-codemode-fixture', private: true, type: 'module' }),
				'wrangler.jsonc': JSON.stringify({
					name: 'codemode-fixture',
					compatibility_date: '2026-06-01',
					compatibility_flags: ['nodejs_compat'],
					migrations: [{ tag: 'v1', new_sqlite_classes: ['FlueResearcherAgent'] }],
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
				'src/agents/researcher.ts': [
					"'use agent';",
					"import { useCodeMode, useMcpConnection, useModel } from '@flue/runtime';",
					"import { DynamicWorkerCodemodeExecutor } from '@flue/runtime/cloudflare';",
					"import { env } from 'cloudflare:workers';",
					'',
					'export function Researcher() {',
					"\tuseModel('anthropic/claude-sonnet-4-6');",
					"\tuseMcpConnection({ name: 'docs', url: 'https://mcp.example.com/mcp' });",
					'\tuseCodeMode({ executor: new DynamicWorkerCodemodeExecutor({ loader: env.LOADER }) });',
					"\treturn 'Answer from the docs.';",
					'}',
					'',
				].join('\n'),
			});

			// `vite build` runs the environment builder when the config has one,
			// which is how @cloudflare/vite-plugin builds the Worker environment.
			const builder = await createBuilder({
				root,
				configFile: false,
				logLevel: 'silent',
				plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
			});
			await builder.buildApp();

			const output = await readTree(path.join(root, 'dist'));
			const javascript = [...output]
				.filter(([file]) => /\.(?:m?js)$/.test(file))
				.map(([, code]) => code)
				.join('\n');
			expect(javascript.length).toBeGreaterThan(0);
			// The MCP client is in the Worker (the coordinator's connection cache)...
			expect(javascript).toContain('Mcp-Session-Id');
			// ...and its stdio transport, with the process spawner, is not.
			expect(javascript).not.toMatch(/["'`](?:node:)?child_process["'`]/);
			expect(javascript).not.toContain('cross-spawn');
			expect(javascript).not.toContain('MCP stdio transport already started');

			const deployConfig = [...output].find(([file]) => path.basename(file) === 'wrangler.json');
			if (!deployConfig) throw new Error(`No wrangler.json in the build output: ${[...output.keys()].join(', ')}`);
			expect(JSON.parse(deployConfig[1]).worker_loaders).toEqual([{ binding: CODEMODE_LOADER_BINDING }]);
		},
		180_000,
	);
});
