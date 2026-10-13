/**
 * `artifact` CLI (live-artifacts A15).
 *
 * lint rejects oversized HTML and credential-like patterns.
 * validate checks the manifest fields the registry will store.
 * Nothing here publishes a revision.
 */

import { compileHtmlArtifactBundle } from './bundle/compiler.ts';

export interface ArtifactCliResult {
	readonly ok: boolean;
	readonly code: number;
	readonly lines: readonly string[];
}

export function runArtifactCli(argv: readonly string[]): ArtifactCliResult {
	const [command, ...rest] = argv;
	if (command === 'lint') return lint(flag(rest, '--html'));
	if (command === 'validate') return validate(rest);
	return { ok: false, code: 2, lines: ['usage: artifact <lint --html HTML | validate --artifact-id ID --tenant TENANT --digest DIGEST --revision REV>'] };
}

function lint(html: string | undefined): ArtifactCliResult {
	if (!html) return { ok: false, code: 2, lines: ['lint requires --html'] };
	try {
		const compiled = compileHtmlArtifactBundle(html);
		return { ok: true, code: 0, lines: [`digest ${compiled.digest}`, `bytes ${compiled.byteLength}`] };
	} catch (error) {
		return { ok: false, code: 1, lines: [error instanceof Error ? error.message : String(error)] };
	}
}

function validate(argv: readonly string[]): ArtifactCliResult {
	const artifactId = flag(argv, '--artifact-id');
	const tenant = flag(argv, '--tenant');
	const digest = flag(argv, '--digest');
	const revision = flag(argv, '--revision');
	const errors: string[] = [];
	if (!artifactId?.startsWith('artifact://')) errors.push('artifact id must start with artifact://');
	if (!tenant) errors.push('tenant is required');
	if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) errors.push('digest must be sha256:<64 hex>');
	if (!revision) errors.push('revision is required');
	if (errors.length > 0) return { ok: false, code: 1, lines: errors };
	return { ok: true, code: 0, lines: [`valid ${artifactId} ${revision}`] };
}

function flag(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	return argv[index + 1];
}
