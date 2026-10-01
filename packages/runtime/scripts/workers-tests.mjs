// Runs the tests that execute inside workerd (`vitest.workers.config.ts`,
// through @cloudflare/vitest-pool-workers and Miniflare) — today Code Mode
// against the Dynamic Worker executor.
//
// workerd ships as a prebuilt binary with a minimum glibc (2.35). On a Linux
// x64 machine whose glibc is older (the BuildBuddy runners run Ubuntu 20.04,
// glibc 2.31), this script fetches a pinned Debian 12 glibc, checks its
// SHA-256, and points Miniflare at a wrapper that runs the real workerd under
// that loader (MINIFLARE_WORKERD_PATH; nymph-ai/nymphai GH #3772). Elsewhere,
// when workerd cannot start, it says exactly why and skips the suite instead
// of failing on an environment the code under test never sees. Any failure
// after workerd starts is a real test failure.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const GLIBC_DEB_URL =
	'https://snapshot.debian.org/archive/debian/20250601T000000Z/pool/main/g/glibc/libc6_2.36-9%2Bdeb12u10_amd64.deb';
const GLIBC_DEB_SHA256 = '5dc83256f10ca4d0f2a53dd6583ffd0d0e319af30074ea6c82fb0ae77bd16365';

function workerdBinary() {
	const fromPool = createRequire(
		fileURLToPath(import.meta.resolve('@cloudflare/vitest-pool-workers')),
	);
	const fromMiniflare = createRequire(fromPool.resolve('miniflare'));
	const workerd = fromMiniflare('workerd');
	return { path: workerd.default, version: workerd.version };
}

function probe(binary) {
	const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
	return result.status === 0
		? undefined
		: (result.error?.message ?? result.stderr ?? '').trim() || `exit status ${result.status}`;
}

/** A wrapper running `workerd` under a pinned newer glibc, or undefined when that cannot be built. */
async function glibcWrapper(workerd) {
	if (process.platform !== 'linux' || process.arch !== 'x64') return undefined;
	if (spawnSync('dpkg-deb', ['--version']).status !== 0) return undefined;
	const work = path.join(os.tmpdir(), 'flue-workerd-glibc');
	const glibc = path.join(work, 'glibc-2.36');
	const loader = path.join(glibc, 'lib/x86_64-linux-gnu/ld-linux-x86-64.so.2');
	if (!fs.existsSync(loader)) {
		fs.mkdirSync(work, { recursive: true });
		const response = await fetch(GLIBC_DEB_URL);
		if (!response.ok) throw new Error(`glibc download failed: HTTP ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		const digest = createHash('sha256').update(bytes).digest('hex');
		if (digest !== GLIBC_DEB_SHA256)
			throw new Error(`glibc download has SHA-256 ${digest}, expected ${GLIBC_DEB_SHA256}`);
		const deb = path.join(work, 'libc6.deb');
		fs.writeFileSync(deb, bytes);
		fs.rmSync(glibc, { recursive: true, force: true });
		const extract = spawnSync('dpkg-deb', ['-x', deb, glibc], { stdio: 'inherit' });
		if (extract.status !== 0) throw new Error('dpkg-deb could not extract the glibc package');
	}
	const wrapper = path.join(work, 'workerd');
	fs.writeFileSync(
		wrapper,
		`#!/bin/sh\nexec "${loader}" --library-path "${path.join(glibc, 'lib/x86_64-linux-gnu')}" --argv0 workerd "${workerd}" "$@"\n`,
	);
	fs.chmodSync(wrapper, 0o755);
	return wrapper;
}

const workerd = workerdBinary();
let failure = probe(process.env.MINIFLARE_WORKERD_PATH ?? workerd.path);
if (failure && !process.env.MINIFLARE_WORKERD_PATH) {
	const wrapper = await glibcWrapper(workerd.path).catch((error) => {
		console.warn(`[flue] Could not prepare a glibc for workerd: ${error.message}`);
		return undefined;
	});
	if (wrapper && !probe(wrapper)) {
		console.warn(`[flue] workerd ${workerd.version} runs under a pinned glibc 2.36 (${wrapper}).`);
		process.env.MINIFLARE_WORKERD_PATH = wrapper;
		failure = undefined;
	}
}
if (failure) {
	console.warn(
		`[flue] SKIPPED vitest.workers.config.ts: workerd ${workerd.version} cannot run on this machine, so Miniflare cannot host the Worker Loader tests.\n${failure}`,
	);
	process.exit(0);
}

const run = spawnSync('vitest', ['run', '--config', 'vitest.workers.config.ts'], {
	stdio: 'inherit',
	shell: process.platform === 'win32',
	env: process.env,
});
process.exit(run.status ?? 1);
