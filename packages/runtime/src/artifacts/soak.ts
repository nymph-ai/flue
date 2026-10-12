/**
 * Local soak for the artifact read path (P22-A12).
 *
 * One in-memory log, many viewers. This is a scaled smoke of the production
 * viewer SLO (`maxViewersPerArtifact`), not a live Electric or Cloudflare run.
 */

import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import { issueViewerToken } from './auth/tokens.ts';
import { MemoryReadGateway } from './gateway/memory-gateway.ts';
import { createFence, stampEvent, type FencedEvent } from './publish/fence.ts';
import { ARTIFACT_SLOS } from './observability/slo.ts';

export interface SoakReport {
	readonly viewers: number;
	readonly events: number;
	readonly distinctSnapshots: number;
	readonly elapsedMs: number;
	readonly sloViewers: number;
}

export async function runLocalSoak(options: {
	readonly viewers: number;
	readonly events: number;
}): Promise<SoakReport> {
	const artifactId = 'artifact://soak/board';
	const stream = 'flue/v1/artifact/soak/board/events';
	const secret = 'soak-secret';
	const log = new InMemoryDurableStreamLog();
	const fence = createFence('agentdo:soak', 1);
	const messages: FencedEvent[] = [];
	for (let n = 1; n <= options.events; n++) {
		messages.push(
			stampEvent(fence, {
				eventId: `soak-${n}`,
				streamId: stream,
				type: 'artifact.state.updated',
				artifactId,
				occurredAt: '2026-10-12T00:00:00.000Z',
				semanticRevision: n,
				payload: { patch: { tick: n } },
			}),
		);
	}
	await log.ensure(stream);
	await log.append(stream, messages);
	const gateway = new MemoryReadGateway({
		log,
		secret,
		streamFor: () => stream,
		now: () => 1_700_000_000_000,
	});
	const started = Date.now();
	const revisions = new Set<number>();
	await Promise.all(
		Array.from({ length: options.viewers }, async (_, index) => {
			const token = issueViewerToken(secret, {
				artifactId,
				tenantId: 'soak',
				principal: `user:${index}`,
				tools: [],
				exp: 1_700_000_000_000 + 60_000,
			});
			const boot = await gateway.bootstrap(artifactId, token);
			revisions.add(boot.snapshot.readModelRevision);
			if (boot.snapshot.state.tick !== options.events) {
				throw new Error(`viewer ${index} saw tick ${String(boot.snapshot.state.tick)}`);
			}
		}),
	);
	return {
		viewers: options.viewers,
		events: options.events,
		distinctSnapshots: revisions.size,
		elapsedMs: Date.now() - started,
		sloViewers: ARTIFACT_SLOS.maxViewersPerArtifact,
	};
}
