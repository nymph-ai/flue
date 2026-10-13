import { describe, expect, it } from 'vitest';
import { appendCreatingMany } from '../../entity/append.ts';
import { InMemoryDurableStreamLog } from '../../streams/memory-log.ts';
import { STREAM_START } from '../../streams/offset.ts';
import { issueViewerToken } from '../auth/tokens.ts';
import { createFence, stampEvent } from '../publish/fence.ts';
import { ArtifactRevokedError, MemoryReadGateway } from './memory-gateway.ts';
import { MemoryViewerAuthorizationPort } from './viewer-auth.ts';

const SECRET = 'gw-secret';
const ARTIFACT = 'artifact://tenant-alpha/board';
const STREAM = 'flue/v1/artifact/tenant-alpha/board/events';
const NOW = 1_700_000_000_000;

function token(): string {
	return issueViewerToken(SECRET, {
		artifactId: ARTIFACT,
		tenantId: 'tenant-alpha',
		principal: 'user:alice',
		tools: [],
		exp: NOW + 60_000,
	});
}

describe('MemoryReadGateway', () => {
	it('streams a later append while the follow session stays open', async () => {
		const log = new InMemoryDurableStreamLog();
		const fence = createFence('agentdo:board', 1);
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
					payload: { patch: { score: 1 } },
				}),
			],
			undefined,
		);
		const gateway = new MemoryReadGateway({
			log,
			secret: SECRET,
			streamFor: () => STREAM,
			now: () => NOW,
			heartbeatMs: 50,
		});
		const boot = await gateway.bootstrap(ARTIFACT, token());
		const controller = new AbortController();
		const events: unknown[] = [];
		const followPromise = (async () => {
			for await (const event of gateway.follow(ARTIFACT, boot.cursor, token(), controller.signal)) {
				events.push(event);
				if (events.length >= 2) controller.abort();
			}
		})();
		await appendCreatingMany(
			log,
			STREAM,
			[
				stampEvent(fence, {
					eventId: 'evt-2',
					streamId: STREAM,
					type: 'artifact.state.updated',
					artifactId: ARTIFACT,
					occurredAt: '2026-10-12T00:00:01.000Z',
					semanticRevision: 2,
					payload: { patch: { score: 2 } },
				}),
			],
			undefined,
		);
		await followPromise;
		expect(events.some((e) => typeof e === 'object' && e !== null && 'eventId' in e && (e as any).eventId === 'evt-2')).toBe(
			true,
		);
	});

	it('rejects follow when the artifact is revoked mid-session', async () => {
		const log = new InMemoryDurableStreamLog();
		const auth = new MemoryViewerAuthorizationPort();
		const gateway = new MemoryReadGateway({
			log,
			secret: SECRET,
			streamFor: () => STREAM,
			now: () => NOW,
			authorization: auth,
		});
		auth.revoke(ARTIFACT);
		await expect(gateway.bootstrap(ARTIFACT, token())).rejects.toBeInstanceOf(ArtifactRevokedError);
	});
});
