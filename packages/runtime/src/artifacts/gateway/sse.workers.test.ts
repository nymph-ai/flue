/**
 * Artifact read gateway inside workerd (Miniflare). Passive viewers must
 * not wake an AgentDO: the SSE response carries x-agentdo-wake: 0.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ARTIFACT = 'artifact://t/a';

describe('artifact SSE gateway in workerd', () => {
	it('bootstraps and streams through the worker fetch handler', async () => {
		const tokenResponse = await SELF.fetch(
			`https://example.com/live-artifacts/token?artifactId=${encodeURIComponent(ARTIFACT)}`,
		);
		expect(tokenResponse.status).toBe(200);
		const { token } = (await tokenResponse.json()) as { token: string };

		const boot = await SELF.fetch(
			`https://example.com/live-artifacts/bootstrap?artifactId=${encodeURIComponent(ARTIFACT)}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		expect(boot.status).toBe(200);
		const body = (await boot.json()) as { snapshot: { state: { home: number } }; cursor: string };
		expect(body.snapshot.state.home).toBe(1);
		expect(body.cursor).toBe('1');

		const stream = await SELF.fetch(
			`https://example.com/live-artifacts/stream?artifactId=${encodeURIComponent(ARTIFACT)}&cursor=1`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		expect(stream.status).toBe(200);
		expect(stream.headers.get('content-type')).toContain('text/event-stream');
		expect(stream.headers.get('x-agentdo-wake')).toBe('0');
		const text = await stream.text();
		expect(text).toContain('"eventId":"e1"');
	});

	it('rejects an unauthenticated bootstrap', async () => {
		const boot = await SELF.fetch(
			`https://example.com/live-artifacts/bootstrap?artifactId=${encodeURIComponent(ARTIFACT)}`,
		);
		expect(boot.status).toBe(401);
	});
});
