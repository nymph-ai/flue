import { describe, expect, it } from 'vitest';
import { appendCreatingMany } from '../entity/append.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import { STREAM_START } from '../streams/offset.ts';
import { authorizeArtifactAction } from './actions/authorize.ts';
import { toAgUi } from './agui.ts';
import { issueViewerToken } from './auth/tokens.ts';
import { MemoryReadGateway } from './gateway/memory-gateway.ts';
import { resolveHostDelivery } from './hosts.ts';
import { ARTIFACT_SLOS } from './observability/slo.ts';
import { promoteEphemeralHtml } from './promotion.ts';
import { createFence, stampEvent, type FencedEvent } from './publish/fence.ts';
import { emptySnapshot, reduceArtifactEvents } from './read-model/reducer.ts';
import { acceptHostMessage } from './security/postmessage.ts';
import { authorAndStage } from './sdk/author.ts';
import { ArtifactRegistry } from './registry.ts';

const SECRET = 'test-secret';
const ARTIFACT = 'artifact://tenant-alpha/scoreboard';
const STREAM = 'flue/v1/artifact/tenant-alpha/scoreboard/events';

function event(fence: ReturnType<typeof createFence>, seqHint: number, patch: Record<string, unknown>): FencedEvent {
	return stampEvent(fence, {
		eventId: `evt-${seqHint}`,
		streamId: STREAM,
		type: 'artifact.state.updated',
		artifactId: ARTIFACT,
		occurredAt: '2026-10-12T00:00:00.000Z',
		semanticRevision: seqHint,
		payload: { patch },
	});
}

describe('live-artifacts live path', () => {
	it('batches appends so N events cost one POST', async () => {
		const log = new InMemoryDurableStreamLog();
		let posts = 0;
		const original = log.append.bind(log);
		log.append = async (path, messages, signal) => {
			const result = await original(path, messages, signal);
			posts += 1;
			return result;
		};
		const fence = createFence('agentdo:score', 1);
		const messages = [1, 2, 3].map((n) => event(fence, n, { home: n }));
		await appendCreatingMany(log, STREAM, messages, undefined);
		expect(posts).toBe(1);
		const read = await log.read(STREAM, STREAM_START);
		expect(read.messages).toHaveLength(3);
	});

	it('lost append ack does not double-apply logical state', () => {
		const fence = createFence('agentdo:score', 3);
		const first = event(fence, 1, { home: 1 });
		const prior = emptySnapshot(ARTIFACT, '2026-10-12T00:00:00.000Z');
		const once = reduceArtifactEvents(prior, [first], { cursor: 'c1', now: 't' });
		const twice = reduceArtifactEvents(once.snapshot, [first, first], { cursor: 'c1', now: 't2' });
		expect(twice.duplicates).toBe(2);
		expect(twice.applied).toBe(0);
		expect(twice.snapshot.state.home).toBe(1);
		expect(twice.snapshot.readModelRevision).toBe(1);
	});

	it('stale producer epoch is rejected', () => {
		const current = createFence('agentdo:score', 2);
		const applied = reduceArtifactEvents(
			emptySnapshot(ARTIFACT, 't'),
			[event(current, 1, { home: 1 })],
			{ cursor: 'c', now: 't' },
		);
		const stale = createFence('agentdo:score', 1);
		expect(() =>
			reduceArtifactEvents(applied.snapshot, [event(stale, 2, { home: 9 })], { cursor: 'c', now: 't' }),
		).toThrow(/stale producer epoch/);
	});

	it('gateway bootstrap is consistent and refuses a foreign token', async () => {
		const log = new InMemoryDurableStreamLog();
		const fence = createFence('agentdo:score', 1);
		await appendCreatingMany(log, STREAM, [event(fence, 1, { home: 2, away: 1 })], undefined);
		const gateway = new MemoryReadGateway({
			log,
			secret: SECRET,
			streamFor: () => STREAM,
			now: () => 1_000,
		});
		const token = issueViewerToken(SECRET, {
			artifactId: ARTIFACT,
			tenantId: 'tenant-alpha',
			principal: 'user:alice',
			tools: ['artifact.score.increment'],
			exp: 5_000,
		});
		const boot = await gateway.bootstrap(ARTIFACT, token);
		expect(boot.snapshot.state.home).toBe(2);
		expect(boot.cursor).toBe(boot.snapshot.cursor);
		const other = issueViewerToken(SECRET, {
			artifactId: 'artifact://other/x',
			tenantId: 'tenant-alpha',
			principal: 'user:eve',
			tools: [],
			exp: 5_000,
		});
		await expect(gateway.bootstrap(ARTIFACT, other)).rejects.toThrow(/unauthorized/);
	});

	it('app-only visibility does not authorize a missing tool grant', () => {
		const claims = {
			artifactId: ARTIFACT,
			tenantId: 'tenant-alpha',
			principal: 'user:alice',
			tools: ['artifact.score.increment'],
			exp: 9,
		};
		const denied = authorizeArtifactAction({
			claims,
			artifactId: ARTIFACT,
			tenantId: 'tenant-alpha',
			toolName: 'artifact.ui.refresh',
			appOnlyTools: ['artifact.ui.refresh'],
			allowedTools: ['artifact.score.increment'],
			revoked: false,
			requiresFabricAdmission: false,
			fabricAdmitted: false,
		});
		expect(denied.allowed).toBe(false);
		expect(denied.code).toBe('UNAUTHORIZED');
	});

	it('governed effects require fabric admission', () => {
		const claims = {
			artifactId: ARTIFACT,
			tenantId: 'tenant-alpha',
			principal: 'user:alice',
			tools: ['admin.wipe'],
			exp: 9,
		};
		const decision = authorizeArtifactAction({
			claims,
			artifactId: ARTIFACT,
			tenantId: 'tenant-alpha',
			toolName: 'admin.wipe',
			appOnlyTools: [],
			allowedTools: ['admin.wipe'],
			revoked: false,
			requiresFabricAdmission: true,
			fabricAdmitted: false,
		});
		expect(decision.code).toBe('FABRIC_ADMISSION_DENIED');
	});

	it('maps flue projections to AG-UI without collapsing artifact identity', () => {
		const mapped = toAgUi({
			kind: 'artifact-snapshot',
			threadId: 'thread-1',
			artifactId: ARTIFACT,
			snapshot: { home: 1 },
		});
		expect(mapped.type).toBe('STATE_SNAPSHOT');
		if (mapped.type === 'STATE_SNAPSHOT') expect(mapped.artifactId).toBe(ARTIFACT);
	});

	it('promotion stays unpublished until review', () => {
		const html = '<!doctype html><html><body>board</body></html>';
		const draft = promoteEphemeralHtml({
			artifactId: ARTIFACT,
			tenantId: 'tenant-alpha',
			html,
		});
		expect(draft.published).toBe(false);
		expect(draft.reviewRequired).toBe(true);
		expect(draft.bundle.digest).toMatch(/^sha256:/);
	});

	it('notion html falls back to a static snapshot plus live link', () => {
		const delivery = resolveHostDelivery('notion-html', 'https://app.nymph.ai/a/scoreboard');
		expect(delivery.mode).toBe('static-snapshot');
		expect(delivery.liveStream).toBe(false);
		expect(delivery.fallbackUrl).toContain('scoreboard');
	});

	it('rejects postMessage from a foreign origin', () => {
		expect(
			acceptHostMessage({
				eventOrigin: 'https://evil.example',
				expectedOrigin: 'https://app.nymph.ai',
				sourceIsParent: true,
			}),
		).toBe(false);
		expect(
			acceptHostMessage({
				eventOrigin: 'https://app.nymph.ai',
				expectedOrigin: 'https://app.nymph.ai',
				sourceIsParent: true,
			}),
		).toBe(true);
	});

	it('authoring stages a reviewable digest under the size SLO', () => {
		const registry = new ArtifactRegistry();
		const html = '<!doctype html><html><body>score</body></html>';
		const staged = authorAndStage({
			registry,
			artifactId: ARTIFACT,
			tenantId: 'tenant-alpha',
			ownerPrincipal: 'user:alice',
			html,
			revisionId: 'rev_1',
			uiResourceUri: 'ui://scoreboard/v1',
		});
		expect(staged.reviewRequired).toBe(true);
		expect(Buffer.byteLength(html)).toBeLessThan(ARTIFACT_SLOS.maxHtmlBytes);
		expect(registry.get(ARTIFACT)?.headRevisionId).toBeNull();
	});
});
