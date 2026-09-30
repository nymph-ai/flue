#!/usr/bin/env bash
# Runs src/streams/electric-log.test.ts and the StreamStorage crash/replay
# suite (src/pi/stream-storage.electric.test.ts) against the real Durable Streams Node
# reference server (`@durable-streams/server`, the server Electric's
# agents-server embeds), including a webhook subscription whose signed wake
# is verified by src/entity/webhook.ts.
#
# The server is installed outside the workspace (no lockfile change) and
# started in-process with a local webhook receiver:
#
#   pnpm --filter @flue/runtime exec bash scripts/test-durable-streams-server.sh
#
# Without these variables the real-server tests are skipped, so the regular
# `pnpm test` never needs a server.
set -euo pipefail

version="${DS_SERVER_VERSION:-0.3}"
work="${TMPDIR:-/tmp}/flue-ds-server"
ds_port="${DS_PORT:-4437}"
hook_port="${DS_HOOK_PORT:-4438}"

mkdir -p "${work}"
npm install --silent --no-audit --no-fund --prefix "${work}" "@durable-streams/server@${version}" >/dev/null
printf 'durable-streams server %s\n' \
	"$(node -p "require('${work}/node_modules/@durable-streams/server/package.json').version")"

cat >"${work}/run.mjs" <<'EOF'
import http from 'node:http';
import { DurableStreamTestServer } from '@durable-streams/server';

const [dsPort, hookPort] = process.argv.slice(2).map(Number);
// Webhook subscriptions are off unless asked for (`webhooks ?? false`).
const server = new DurableStreamTestServer({
	port: dsPort,
	host: '127.0.0.1',
	longPollTimeout: 2000,
	webhooks: true,
});
await server.start();

// The webhook receiver answers `{ done: true }` and keeps the last delivery,
// raw, for the test to verify.
let captured = null;
http
	.createServer(async (req, res) => {
		if (req.method === 'POST' && req.url === '/hook') {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			captured = {
				header: req.headers['webhook-signature'] ?? null,
				body: Buffer.concat(chunks).toString('utf8'),
			};
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"done":true}');
			return;
		}
		if (req.method === 'GET' && req.url === '/captured') {
			res.writeHead(captured ? 200 : 404, { 'content-type': 'application/json' });
			res.end(JSON.stringify(captured));
			return;
		}
		res.writeHead(404);
		res.end();
	})
	.listen(hookPort, '127.0.0.1');
console.log(`durable-streams server on ${server.url}, webhook receiver on :${hookPort}`);
EOF

(cd "${work}" && exec node run.mjs "${ds_port}" "${hook_port}") &
server_pid=$!
trap 'kill "${server_pid}" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
	if curl --silent --output /dev/null "http://127.0.0.1:${ds_port}/"; then break; fi
	sleep 0.2
done

FLUE_DS_URL="http://127.0.0.1:${ds_port}/v1/stream" \
FLUE_DS_WEBHOOK_URL="http://127.0.0.1:${hook_port}/hook" \
FLUE_DS_WEBHOOK_CAPTURE_URL="http://127.0.0.1:${hook_port}/captured" \
	vitest run src/streams/electric-log.test.ts src/pi/stream-storage.electric.test.ts "$@"
