/**
 * In-process read gateway (P22-A5).
 *
 * Viewers bootstrap a consistent snapshot+cursor and follow the log. This
 * object never calls an AgentDO. Authorization is re-checked on every read.
 */

import type { DurableStreamLog } from '../../streams/log.ts';
import { asStreamOffset, isResumeOffset, STREAM_START } from '../../streams/offset.ts';
import { verifyViewerToken } from '../auth/tokens.ts';
import { reduceArtifactEvents, emptySnapshot } from '../read-model/reducer.ts';
import type { FencedEvent } from '../publish/fence.ts';
import type { ReadGatewayBootstrap, ReadGatewayPort } from './read-gateway.ts';

export class UnauthorizedError extends Error {
	constructor(message = 'unauthorized') {
		super(message);
		this.name = 'UnauthorizedError';
	}
}

export class MemoryReadGateway implements ReadGatewayPort {
	constructor(
		private readonly options: {
			readonly log: DurableStreamLog;
			readonly secret: string;
			readonly streamFor: (artifactId: string) => string;
			readonly now?: () => number;
		},
	) {}

	async bootstrap(artifactId: string, viewerToken: string): Promise<ReadGatewayBootstrap> {
		this.#auth(artifactId, viewerToken);
		const path = this.options.streamFor(artifactId);
		const head = await this.options.log.head(path);
		const cursor = head?.nextOffset ?? STREAM_START;
		const batch = await this.options.log.read(path, STREAM_START);
		const events = batch.messages.filter(isFenced);
		const reduced = reduceArtifactEvents(emptySnapshot(artifactId, new Date().toISOString()), events, {
			cursor,
			now: new Date().toISOString(),
		});
		if (reduced.gap) {
			// Retention gap or skipped seq: caller must treat snapshot as authoritative
			// and resume only from this cursor (no partial replay).
		}
		return { snapshot: reduced.snapshot, cursor };
	}

	async *follow(artifactId: string, cursor: string, viewerToken: string): AsyncIterable<unknown> {
		this.#auth(artifactId, viewerToken);
		const path = this.options.streamFor(artifactId);
		if (!isResumeOffset(cursor)) throw new UnauthorizedError('invalid cursor');
		const batch = await this.options.log.read(path, asStreamOffset(cursor));
		for (const message of batch.messages) yield message;
	}

	#auth(artifactId: string, viewerToken: string): void {
		const claims = verifyViewerToken(
			this.options.secret,
			viewerToken,
			this.options.now?.() ?? Date.now(),
		);
		if (!claims || claims.artifactId !== artifactId) {
			throw new UnauthorizedError();
		}
	}
}

function isFenced(value: unknown): value is FencedEvent {
	return Boolean(value && typeof value === 'object' && 'eventId' in value && 'producerEpoch' in value);
}
