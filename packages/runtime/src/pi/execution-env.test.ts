import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { describe, expect, it } from 'vitest';
import type { SandboxDriver } from '../sandbox.ts';
import type { FileStat } from '../types.ts';
import { executionEnvFromSandbox, normalizePosixPath } from './execution-env.ts';

const context = BACKGROUND_CONTEXT;

/** A map-backed driver: enough filesystem for the adapter's contract. */
function memoryDriver(): SandboxDriver & { files: Map<string, Uint8Array>; commands: string[] } {
	const files = new Map<string, Uint8Array>();
	const dirs = new Set<string>(['/']);
	const commands: string[] = [];
	const missing = (path: string) => new Error(`ENOENT: no such file or directory, ${path}`);
	return {
		files,
		commands,
		async readFile(path) {
			const bytes = files.get(path);
			if (!bytes) throw missing(path);
			return new TextDecoder().decode(bytes);
		},
		async readFileBuffer(path) {
			const bytes = files.get(path);
			if (!bytes) throw missing(path);
			return bytes;
		},
		async writeFile(path, content) {
			const parent = path.slice(0, path.lastIndexOf('/')) || '/';
			if (!dirs.has(parent)) throw missing(parent);
			files.set(path, typeof content === 'string' ? new TextEncoder().encode(content) : content);
		},
		async stat(path): Promise<FileStat> {
			if (dirs.has(path)) return { isFile: false, isDirectory: true };
			const bytes = files.get(path);
			if (!bytes) throw missing(path);
			return { isFile: true, isDirectory: false, size: bytes.byteLength };
		},
		async readdir(path) {
			const prefix = path === '/' ? '/' : `${path}/`;
			return [...files.keys(), ...dirs]
				.filter((entry) => entry !== path && entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'))
				.map((entry) => entry.slice(prefix.length));
		},
		async exists(path) {
			return dirs.has(path) || files.has(path);
		},
		async mkdir(path, options) {
			const parts = path.split('/').filter(Boolean);
			for (let index = 1; index <= parts.length; index++) {
				const dir = `/${parts.slice(0, index).join('/')}`;
				if (!options?.recursive && index < parts.length && !dirs.has(dir)) throw missing(dir);
				dirs.add(dir);
			}
		},
		async rm(path) {
			files.delete(path);
			dirs.delete(path);
		},
		async exec(command, options) {
			commands.push(`${options?.cwd ?? ''}$ ${command}`);
			return command === 'fail' ? { stdout: '', stderr: 'boom\n', exitCode: 2 } : { stdout: 'ok\n', stderr: '', exitCode: 0 };
		},
	};
}

describe('executionEnvFromSandbox', () => {
	it('normalizes POSIX paths without node:path', () => {
		expect(normalizePosixPath('/a/./b/../c//d')).toBe('/a/c/d');
		expect(normalizePosixPath('/..')).toBe('/');
		expect(normalizePosixPath('a/../../b')).toBe('../b');
	});

	it('resolves against cwd and round-trips files through the driver', async () => {
		const driver = memoryDriver();
		const env = executionEnvFromSandbox(driver, '/work');
		expect((await env.writeFile('notes/a.txt', 'one\ntwo\n', context)).ok).toBe(true);
		expect(driver.files.has('/work/notes/a.txt')).toBe(true);
		const text = await env.readTextFile('/work/notes/a.txt', context);
		expect(text).toEqual({ ok: true, value: 'one\ntwo\n' });
		expect(await env.readTextLines('notes/a.txt', { maxLines: 1 }, context)).toEqual({ ok: true, value: ['one'] });
		expect((await env.appendFile('notes/a.txt', 'three', context)).ok).toBe(true);
		expect((await env.readTextFile('notes/a.txt', context)).ok && driver.files.get('/work/notes/a.txt')?.length).toBe(
			13,
		);
		expect((await env.renameFile('notes/a.txt', 'b.txt', context)).ok).toBe(true);
		expect(driver.files.has('/work/b.txt')).toBe(true);
		expect(driver.files.has('/work/notes/a.txt')).toBe(false);
		const info = await env.fileInfo('b.txt', context);
		expect(info.ok && info.value).toMatchObject({ name: 'b.txt', path: '/work/b.txt', kind: 'file', size: 13 });
	});

	it('maps missing files to not_found', async () => {
		const env = executionEnvFromSandbox(memoryDriver(), '/work');
		const result = await env.readTextFile('nope.txt', context);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe('not_found');
	});

	it('runs commands in cwd and streams output', async () => {
		const driver = memoryDriver();
		const env = executionEnvFromSandbox(driver, '/work');
		const chunks: string[] = [];
		const ran = await env.exec('echo ok', { onOutput: (text) => chunks.push(text) }, context);
		expect(ran).toEqual({ ok: true, value: { exitCode: 0 } });
		expect(chunks).toEqual(['ok\n']);
		expect(driver.commands).toEqual(['/work$ echo ok']);
		const failed = await env.exec('fail', undefined, context);
		expect(failed).toEqual({ ok: true, value: { exitCode: 2 } });
	});
});
