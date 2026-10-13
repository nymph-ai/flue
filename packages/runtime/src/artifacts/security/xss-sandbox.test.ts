import { readFileSync, accessSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileHtmlArtifactBundle } from '../bundle/compiler.ts';

const here = dirname(fileURLToPath(import.meta.url));

function chromeBinary(): string | undefined {
	const candidates = [
		process.env.CHROME_PATH,
		'/usr/local/bin/google-chrome',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
	].filter((value): value is string => Boolean(value));
	return candidates.find((path) => {
		try {
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

interface CorpusEntry {
	id: string;
	class: string;
	html?: string;
}

describe('XSS and sandbox corpus', () => {
	it('rejects credential payloads in the compiler class', () => {
		const corpus = JSON.parse(readFileSync(join(here, 'xss-corpus.json'), 'utf8')) as CorpusEntry[];
		const compilerEntries = corpus.filter((entry) => entry.class === 'compiler');
		expect(compilerEntries.length).toBeGreaterThan(0);
		for (const entry of compilerEntries) {
			expect(() => compileHtmlArtifactBundle(entry.html ?? ''), entry.id).toThrow(/forbidden credential/);
		}
	});

	it('rejects supply-chain remote script and import-map CDN entries', () => {
		const corpus = JSON.parse(readFileSync(join(here, 'xss-corpus.json'), 'utf8')) as CorpusEntry[];
		const supply = corpus.filter((entry) => entry.class === 'supply-chain');
		expect(supply.length).toBeGreaterThanOrEqual(2);
		for (const entry of supply) {
			expect(() => compileHtmlArtifactBundle(entry.html ?? ''), entry.id).toThrow(/remote|supply|forbidden|cdn/i);
		}
	});

	it.skipIf(!chromeBinary())('blocks parent DOM, cookies, and top navigation in headless Chrome', async () => {
		const result = await new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, [join(here, 'xss-sandbox-harness.mjs')], {
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, CHROME_PATH: chromeBinary() },
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});
			child.on('error', reject);
			child.on('close', (code) => {
				if (code !== 0) reject(new Error(stderr || stdout));
				else resolve(stdout);
			});
		});
		const parsed = JSON.parse(result) as { ok: boolean; report: { parentAccess: string; topNav: string } };
		expect(parsed.ok).toBe(true);
		expect(parsed.report.parentAccess).toMatch(/^threw:/);
		expect(parsed.report.topNav).toMatch(/^threw:/);
	}, 45_000);
});
