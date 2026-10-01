import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import {
	CONFORMANCE_CASES,
	runConformanceCase,
} from '../pi/codemode/conformance/corpus.ts';
import { type CodemodeWorkerLoader, DynamicWorkerCodemodeExecutor } from './codemode-dynamic-worker.ts';

/**
 * A Node stand-in for the Worker Loader: each `load()` writes the Worker's
 * modules to a directory and runs the main module's default entrypoint in a
 * worker thread — its own V8 isolate and global scope, like a Dynamic Worker —
 * with `cloudflare:workers` replaced by a bare `WorkerEntrypoint` class and
 * the two RPC callbacks carried over `postMessage`. Disposing the call
 * terminates the thread.
 *
 * This runs the executor's generated Dynamic Worker code and its host half on
 * V8 with the real module layout; it is not workerd. The same corpus runs in
 * workerd itself in `../pi/codemode/conformance/dynamic-worker.workers.test.ts`.
 */
const BOOTSTRAP = `import { parentPort, workerData } from "node:worker_threads";
const pending = new Map();
let nextId = 0;
parentPort.on("message", (message) => {
	if (message.type !== "reply") return;
	const entry = pending.get(message.id);
	pending.delete(message.id);
	entry.resolve(message.value);
});
const call = (...args) =>
	new Promise((resolve) => {
		const id = nextId++;
		pending.set(id, { resolve });
		parentPort.postMessage({ type: "call", id, args });
	});
const output = (item) => {
	parentPort.postMessage({ type: "output", item });
	return Promise.resolve();
};
try {
	const module = await import(workerData.main);
	const result = await new module.default().run(workerData.input, call, output);
	parentPort.postMessage({ type: "result", result });
} catch (error) {
	parentPort.postMessage({ type: "error", name: error?.name, message: String(error?.message ?? error) });
}
`;

const CLOUDFLARE_WORKERS_IMPORT = 'import { WorkerEntrypoint } from "cloudflare:workers";';

type RunArgs = [unknown, (...args: unknown[]) => Promise<unknown>, (item: unknown) => void];

function nodeWorkerLoader(root: string): CodemodeWorkerLoader {
	let count = 0;
	const run = (code: WorkerLoaderWorkerCode, [input, call, output]: RunArgs) => {
		const dir = path.join(root, `worker-${count++}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
		for (const [name, source] of Object.entries(code.modules)) {
			if (typeof source !== 'string') throw new Error(`unexpected module type for ${name}`);
			const text =
				name === code.mainModule
					? source.replace(CLOUDFLARE_WORKERS_IMPORT, 'class WorkerEntrypoint {}')
					: source;
			fs.writeFileSync(path.join(dir, name), text);
		}
		fs.writeFileSync(path.join(dir, 'bootstrap.mjs'), BOOTSTRAP);
		const worker = new Worker(path.join(dir, 'bootstrap.mjs'), {
			workerData: { main: pathToFileURL(path.join(dir, code.mainModule)).href, input },
		});
		const promise = new Promise((resolve, reject) => {
			worker.on('message', (message) => {
				if (message.type === 'call') {
					void call(...message.args).then((value) => worker.postMessage({ type: 'reply', id: message.id, value }));
				} else if (message.type === 'output') {
					output(message.item);
				} else if (message.type === 'result') {
					resolve(message.result);
					void worker.terminate();
				} else if (message.type === 'error') {
					reject(Object.assign(new Error(message.message), { name: message.name }));
					void worker.terminate();
				}
			});
			worker.on('error', reject);
		});
		return Object.assign(promise, {
			[Symbol.dispose]: () => {
				void worker.terminate();
			},
		});
	};
	return {
		get() {
			throw new Error('the executor loads each script with load()');
		},
		load(code) {
			return {
				getEntrypoint: () => ({ run: (...args: RunArgs) => run(code, args) }),
			} as unknown as WorkerStub;
		},
	};
}

describe('DynamicWorkerCodemodeExecutor on a Node stand-in for the Worker Loader', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-dynamic-worker-'));
	const executor = new DynamicWorkerCodemodeExecutor({ loader: nodeWorkerLoader(root) });
	afterAll(async () => {
		await executor.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	for (const testCase of CONFORMANCE_CASES) {
		it(testCase.name, async () => {
			expect(await runConformanceCase(executor, testCase)).toEqual(testCase.expected);
		});
	}

	it('keeps the script frames in a script error stack, once', async () => {
		const result = await executor.execute('\nthrow new Error("boom");', [], { timeoutMs: 10_000 });
		if (result.ok) throw new Error('expected a script error');
		const lines = result.error.stack?.split('\n') ?? [];
		expect(lines[0]).toBe('Error: boom');
		expect(lines[1]).not.toBe('Error: boom');
		expect(result.error.stack).toContain('codemode.js:2');
		expect(result.error.stack).not.toContain('codemode-prelude.js');
	});

	it('requires a Worker Loader binding', () => {
		expect(() => new DynamicWorkerCodemodeExecutor({} as never)).toThrow(/needs a Worker Loader binding/);
	});
});
