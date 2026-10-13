/**
 * Headless sandbox corpus (live-artifacts A4).
 *
 * Serves a host page and a sandboxed iframe (allow-scripts only) and asks
 * Chrome to dump the DOM after the iframe reports what it could touch.
 *
 *   node xss-sandbox-harness.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome';

const PARENT = `<!doctype html>
<html>
<head><title>host</title></head>
<body>
<script>
document.cookie = 'session=secret; path=/';
window.addEventListener('message', (event) => {
  const el = document.getElementById('report');
  el.textContent = JSON.stringify(event.data);
  el.setAttribute('data-ready', '1');
});
</script>
<iframe sandbox="allow-scripts" src="/child.html"></iframe>
<pre id="report">pending</pre>
</body>
</html>`;

const CHILD = `<!doctype html>
<html>
<body>
<script>
const report = { parentAccess: '', cookie: '', topNav: '', ran: true };
try {
  report.parentAccess = String(parent.document.title);
} catch (error) {
  report.parentAccess = 'threw:' + error.name;
}
try {
  report.cookie = document.cookie || '(empty)';
} catch (error) {
  report.cookie = 'threw:' + error.name;
}
try {
  top.location.href = 'https://evil.example/phish';
  report.topNav = 'set';
} catch (error) {
  report.topNav = 'threw:' + error.name;
}
parent.postMessage(report, '*');
</script>
</body>
</html>`;

function listen() {
	const server = createServer((req, res) => {
		if (req.url === '/child.html') {
			res.setHeader('content-type', 'text/html; charset=utf-8');
			res.end(CHILD);
			return;
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.setHeader('set-cookie', 'session=secret; Path=/');
		res.end(PARENT);
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			resolve({ server, port: address.port });
		});
	});
}

function dumpDom(url) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			CHROME,
			[
				'--headless=new',
				'--no-sandbox',
				'--disable-gpu',
				'--disable-dev-shm-usage',
				`--user-data-dir=${mkdtempSync(join(tmpdir(), 'live-artifacts-chrome-'))}`,
				'--no-first-run',
				'--virtual-time-budget=5000',
				'--dump-dom',
				url,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code !== 0 && !stdout.includes('data-ready')) {
				reject(new Error(`chrome exit ${code}: ${stderr.slice(0, 500)}`));
				return;
			}
			resolve(stdout);
		});
	});
}

const { server, port } = await listen();
try {
	const dom = await dumpDom(`http://127.0.0.1:${port}/`);
	const match = dom.match(/<pre id="report"[^>]*>([^<]*)<\/pre>/);
	const raw = match?.[1] ?? '';
	if (raw === 'pending' || !raw) {
		throw new Error(`iframe report missing from DOM:\n${dom.slice(0, 800)}`);
	}
	const report = JSON.parse(raw);
	const failures = [];
	if (!String(report.parentAccess).startsWith('threw:')) failures.push(`parent DOM readable: ${report.parentAccess}`);
	if (String(report.cookie).includes('session=secret')) failures.push(`cookie inherited: ${report.cookie}`);
	if (!String(report.topNav).startsWith('threw:')) failures.push(`top navigation succeeded: ${report.topNav}`);
	if (!dom.includes('<title>host</title>')) failures.push('host document navigated away');
	if (failures.length > 0) {
		console.error(JSON.stringify({ ok: false, report, failures }, null, 2));
		process.exitCode = 1;
	} else {
		console.log(JSON.stringify({ ok: true, report }));
	}
} finally {
	server.close();
}
