// Runs the tests that execute inside workerd (`vitest.workers.config.ts`,
// through @cloudflare/vitest-pool-workers and Miniflare) — today the Code Mode
// conformance corpus against the Dynamic Worker executor.
//
// workerd ships as a prebuilt binary with a minimum glibc. On a machine where
// that binary cannot start, the pool cannot start either, so this script runs
// the binary first and, when it fails, says exactly why and skips the suite
// instead of failing on an environment the code under test never sees. Any
// failure after workerd starts is a real test failure.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function workerdBinary() {
	const fromPool = createRequire(fileURLToPath(import.meta.resolve('@cloudflare/vitest-pool-workers')));
	const fromMiniflare = createRequire(fromPool.resolve('miniflare'));
	const workerd = fromMiniflare('workerd');
	return { path: workerd.default, version: workerd.version };
}

const workerd = workerdBinary();
const probe = spawnSync(workerd.path, ['--version'], { encoding: 'utf8' });
if (probe.status !== 0) {
	const reason = (probe.error?.message ?? probe.stderr ?? '').trim() || `exit status ${probe.status}`;
	console.warn(
		`[flue] SKIPPED vitest.workers.config.ts: workerd ${workerd.version} cannot run on this machine, so Miniflare cannot host the Worker Loader tests.\n${reason}`,
	);
	process.exit(0);
}

const run = spawnSync('vitest', ['run', '--config', 'vitest.workers.config.ts'], {
	stdio: 'inherit',
	shell: process.platform === 'win32',
});
process.exit(run.status ?? 1);
