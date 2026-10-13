import { describe, expect, it } from 'vitest';
import { appendCreatingMany } from '../../entity/append.ts';
import { InMemoryDurableStreamLog } from '../../streams/memory-log.ts';
import { STREAM_START } from '../../streams/offset.ts';
import { issueViewerToken } from '../auth/tokens.ts';
import { createFence, stampEvent } from '../publish/fence.ts';
import { MemoryReadGateway } from './memory-gateway.ts';
import { createArtifactGateway } from './worker.ts';

const SECRET = 'gateway-secret';
const ARTIFACT = 'artifact://tenant-alpha/scoreboard';
const STREAM = 'flue/v1/artifact/tenant-alpha/scoreboard/events';
const NOW = 1_700_000_000_000;

function token(artifactId = ARTIFACT): string {
	return issueViewerToken(SECRET, {
		artifactId,
		tenantId: 'tenant-alpha',
		principal: 'user:alice',
		tools: [],
		exp: NOW + 60_000,
	});
}

async function handler() {
	const log = new InMemoryDurableStreamLog();
	const fence = createFence('agentdo:score', 1);
	await appendCreatingMany(
		log,
		STREAM,
		[
			stampEvent(fence, {
				eventId: 'evt-1',
				streamId: STREAM,
				type: 'artifact.state.updated',
				artifactId: ARTIFACT,
				occurredAt: '2026-10-12T00:00:00.000Z',
				semanticRevision: 1,
				payload: { patch: { home: 3 } },
			}),
		],
		undefined,
	);
	return createArtifactGateway({
		secret: SECRET,
		now: () => NOW,
		gateway: new MemoryReadGateway({
			log,
			secret: SECRET,
			streamFor: () => STREAM,
			now: () => NOW,
		}),
	});
}

describe('artifact SSE worker', () => {
	it('bootstraps JSON and streams SSE without an AgentDO wake header', async () => {
		const app = await handler();
		const boot = await app.fetch(
			new Request(`https://gw.example/p22/bootstrap?artifactId=${encodeURIComponent(ARTIFACT)}`, {
				headers: { authorization: `Bearer ${token()}` },
			}),
		);
		expect(boot.status).toBe(200);
		const body = (await boot.json()) as { snapshot: { state: { home: number } }; cursor: string };
		expect(body.snapshot.state.home).toBe(3);
		expect(body.cursor.length).toBeGreaterThan(0);

		const controller = new AbortController();
		const stream = await app.fetch(
			new Request(
				`https://gw.example/p22/stream?artifactId=${encodeURIComponent(ARTIFACT)}&cursor=${encodeURIComponent(STREAM_START)}`,
				{ headers: { authorization: `Bearer ${token()}` }, signal: controller.signal },
			),
		);
		expect(stream.headers.get('content-type')).toContain('text/event-stream');
		expect(stream.headers.get('x-agentdo-wake')).toBe('0');
		const reader = stream.body?.getReader();
		const decoder = new TextDecoder();
		let text = '';
		if (reader) {
			const chunk = await reader.read();
			text = decoder.decode(chunk.value);
			controller.abort();
			await reader.cancel();
		}
		expect(text.startsWith('data: ')).toBe(true);
		expect(text).toContain('evt-1');
	});

	it('refuses a missing token and a token for another artifact', async () => {
		const app = await handler();
		const missing = await app.fetch(
			new Request(`https://gw.example/p22/bootstrap?artifactId=${encodeURIComponent(ARTIFACT)}`),
		);
		expect(missing.status).toBe(401);
		const foreign = await app.fetch(
			new Request(`https://gw.example/p22/bootstrap?artifactId=${encodeURIComponent(ARTIFACT)}`, {
				headers: { authorization: `Bearer ${token('artifact://other/x')}` },
			}),
		);
		expect(foreign.status).toBe(401);
	});
});
