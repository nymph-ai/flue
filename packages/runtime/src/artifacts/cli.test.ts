import { describe, expect, it } from 'vitest';
import { runArtifactCli } from './cli.ts';

const HTML = '<!doctype html><html><body>score</body></html>';

describe('artifact CLI', () => {
	it('lints html and prints a digest', () => {
		const result = runArtifactCli(['lint', '--html', HTML]);
		expect(result.ok).toBe(true);
		expect(result.lines[0]).toMatch(/^digest sha256:[a-f0-9]{64}$/);
	});

	it('rejects credential-like html', () => {
		const result = runArtifactCli([
			'lint',
			'--html',
			'<html>Bearer abcdefghijklmnopqrstuvwxyz012345</html>',
		]);
		expect(result.ok).toBe(false);
		expect(result.lines.join('\n')).toMatch(/forbidden credential/);
	});

	it('validates a manifest and rejects a bad digest', () => {
		const digest = 'sha256:' + 'ab'.repeat(32);
		const ok = runArtifactCli([
			'validate',
			'--artifact-id',
			'artifact://t/a',
			'--tenant',
			't',
			'--digest',
			digest,
			'--revision',
			'rev_1',
		]);
		expect(ok.ok).toBe(true);
		const bad = runArtifactCli([
			'validate',
			'--artifact-id',
			'not-an-artifact',
			'--tenant',
			't',
			'--digest',
			'sha1:nope',
			'--revision',
			'',
		]);
		expect(bad.ok).toBe(false);
		expect(bad.code).toBe(1);
	});
});
