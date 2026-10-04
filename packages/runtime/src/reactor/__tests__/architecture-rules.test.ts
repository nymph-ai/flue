import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function findFiles(dir: string, extension = '.ts'): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(...findFiles(full, extension));
		} else if (full.endsWith(extension)) {
			results.push(full);
		}
	}
	return results;
}

describe('Flue Coordination Architecture Rules', () => {
	const srcDir = resolve(__dirname, '../../');

	it('Rule 1: armWake never appears in pi/, entity/questions.ts, or entity/schedules.ts', () => {
		const piFiles = findFiles(join(srcDir, 'pi'));
		const restrictedFiles = [
			...piFiles,
			join(srcDir, 'entity', 'questions.ts'),
			join(srcDir, 'entity', 'schedules.ts'),
		];

		const violations: string[] = [];
		for (const file of restrictedFiles) {
			const content = readFileSync(file, 'utf-8');
			if (content.includes('armWake')) {
				violations.push(file);
			}
		}

		expect(violations, `armWake found in restricted files: ${violations.join(', ')}`).toEqual([]);
	});

	it('Rule 2: appendCreating never appears outside Reactor and transport infrastructure', () => {
		const allFiles = findFiles(srcDir);
		const allowedFiles = new Set([
			resolve(srcDir, 'entity', 'append.ts'),
			resolve(srcDir, 'reactor', 'reactor.ts'),
			resolve(__dirname, 'architecture-rules.test.ts'),
		]);

		const violations: string[] = [];
		for (const file of allFiles) {
			if (allowedFiles.has(resolve(file))) continue;
			const content = readFileSync(file, 'utf-8');
			if (content.includes('appendCreating')) {
				violations.push(file);
			}
		}

		expect(
			violations,
			`appendCreating found outside Reactor/transport infrastructure: ${violations.join(', ')}`,
		).toEqual([]);
	});

	it('Rule 3: host.wake( never appears outside Reactor', () => {
		const allFiles = findFiles(srcDir);
		const allowedFiles = new Set([
			resolve(srcDir, 'reactor', 'reactor.ts'),
			resolve(srcDir, 'pi', 'host.test.ts'),
			resolve(__dirname, 'architecture-rules.test.ts'),
		]);

		const violations: string[] = [];
		for (const file of allFiles) {
			if (allowedFiles.has(resolve(file))) continue;
			const content = readFileSync(file, 'utf-8');
			if (content.includes('host.wake(')) {
				violations.push(file);
			}
		}

		expect(violations, `host.wake( found outside Reactor: ${violations.join(', ')}`).toEqual([]);
	});

	it('Rule 4: reconcileSettlements( or flushOutbox( never appear outside Reactor and its tests', () => {
		const allFiles = findFiles(srcDir);
		const allowedFiles = new Set([
			resolve(srcDir, 'reactor', 'reactor.ts'),
			resolve(__dirname, 'reactor.test.ts'),
			resolve(__dirname, 'architecture-rules.test.ts'),
		]);

		const violations: string[] = [];
		for (const file of allFiles) {
			if (allowedFiles.has(resolve(file))) continue;
			const content = readFileSync(file, 'utf-8');
			if (content.includes('reconcileSettlements(') || content.includes('flushOutbox(')) {
				violations.push(file);
			}
		}

		expect(
			violations,
			`reconcileSettlements( or flushOutbox( found outside Reactor: ${violations.join(', ')}`,
		).toEqual([]);
	});

	it('Rule 5: reason.kind never controls runtime semantics outside ingress/telemetry', () => {
		const allFiles = findFiles(srcDir);
		const allowedFiles = new Set([
			resolve(__dirname, 'architecture-rules.test.ts'),
		]);

		const violations: string[] = [];
		for (const file of allFiles) {
			if (allowedFiles.has(resolve(file))) continue;
			const content = readFileSync(file, 'utf-8');
			if (content.includes('reason.kind')) {
				violations.push(file);
			}
		}

		expect(
			violations,
			`reason.kind found in runtime: ${violations.join(', ')}`,
		).toEqual([]);
	});
});
