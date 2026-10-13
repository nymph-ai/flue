/**
 * In-process read gateway (P22-A5).
 *
 * Viewers bootstrap a consistent snapshot+cursor and follow the log. This
 * object never calls an AgentDO. Authorization is re-checked on every read.
 */

import type { DurableStreamLog } from '../../streams/log.ts';
import { asStreamOffset, compareOffsets, isResumeOffset, STREAM_START } from '../../streams/offset.ts';
import { verifyViewerToken } from '../auth/tokens.ts';
import { reduceArtifactEvents, emptySnapshot } from '../read-model/reducer.ts';
import type { FencedEvent } from '../publish/fence.ts';
import type { ReadGatewayBootstrap, ReadGatewayPort } from './read-gateway.ts';
import type { ViewerAuthorizationPort } from './viewer-auth.ts';

export class UnauthorizedError extends Error {
	constructor(message = 'unauthorized') {
		super(message);
		this.name = 'UnauthorizedError';
	}
}

export class ArtifactRevokedError extends Error {
	constructor(message = 'artifact revoked') {
		super(message);
		this.name = 'ArtifactRevokedError';
	}
}

const HEARTBEAT_MS = 15_000;

export class MemoryReadGateway implements ReadGatewayPort {
	constructor(
		private readonly options: {
			readonly log: DurableStreamLog;
			readonly secret: string;
			readonly streamFor: (artifactId: string) => string;
			readonly now?: () => number;
			readonly authorization?: ViewerAuthorizationPort;
			readonly heartbeatMs?: number;
		},
	) {}

	async bootstrap(artifactId: string, viewerToken: string): Promise<ReadGatewayBootstrap> {
		this.#auth(artifactId, viewerToken);
		const path = this.options.streamFor(artifactId);
		const batch = await this.options.log.read(path, STREAM_START);
		const head = await this.options.log.head(path);
		const cursor = head?.nextOffset ?? batch.nextOffset ?? STREAM_START;
		const events = batch.messages.filter(isFenced);
		const reduced = reduceArtifactEvents(emptySnapshot(artifactId, new Date().toISOString()), events, {
			cursor,
			now: new Date().toISOString(),
		});
		return { snapshot: reduced.snapshot, cursor };
	}

	async *follow(
		artifactId: string,
		cursor: string,
		viewerToken: string,
		signal?: AbortSignal,
	): AsyncIterable<unknown> {
		this.#auth(artifactId, viewerToken);
		const path = this.options.streamFor(artifactId);
		if (!isResumeOffset(cursor)) throw new UnauthorizedError('invalid cursor');
		let offset = asStreamOffset(cursor);
		const log = this.options.log;
		const heartbeatMs = this.options.heartbeatMs ?? HEARTBEAT_MS;

		while (!signal?.aborted) {
			this.#auth(artifactId, viewerToken);
			const batch = await log.read(path, offset);
			for (const message of batch.messages) {
				yield message;
			}
			offset = batch.nextOffset;
			if (!batch.upToDate) continue;

			const nextAppend = await waitForAppend(log, path, offset, signal, heartbeatMs);
			if (nextAppend === 'heartbeat') {
				yield { type: 'gateway.heartbeat', artifactId, cursor: offset };
				continue;
			}
			if (nextAppend === 'aborted') return;
		}
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
		if (this.options.authorization) {
			if (this.options.authorization.isArtifactRevoked(artifactId)) {
				throw new ArtifactRevokedError();
			}
			if (!this.options.authorization.principalAllowed(claims)) {
				throw new UnauthorizedError();
			}
		}
	}
}

function waitForAppend(
	log: DurableStreamLog,
	path: string,
	after: string,
	signal: AbortSignal | undefined,
	heartbeatMs: number,
): Promise<'append' | 'heartbeat' | 'aborted'> {
	if (signal?.aborted) return Promise.resolve('aborted');
	if (!('onAppend' in log) || typeof (log as InMemoryDurableStreamLogLike).onAppend !== 'function') {
		return sleep(heartbeatMs, signal).then((aborted) => (aborted ? 'aborted' : 'heartbeat'));
	}
	const memoryLog = log as InMemoryDurableStreamLogLike;
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: 'append' | 'heartbeat' | 'aborted') => {
			if (timer) clearTimeout(timer);
			unsub();
			resolve(value);
		};
		const unsub = memoryLog.onAppend((p, nextOffset) => {
			if (p === path && compareOffsets(nextOffset, after) > 0) finish('append');
		});
		timer = setTimeout(() => finish('heartbeat'), heartbeatMs);
		if (signal) {
			signal.addEventListener('abort', () => finish('aborted'), { once: true });
		}
	});
}

interface InMemoryDurableStreamLogLike {
	onAppend(listener: (path: string, nextOffset: string) => void): () => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(true);
			return;
		}
		const timer = setTimeout(() => resolve(Boolean(signal?.aborted)), ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			resolve(true);
		}, { once: true });
	});
}

function isFenced(value: unknown): value is FencedEvent {
	return Boolean(value && typeof value === 'object' && 'eventId' in value && 'producerEpoch' in value);
}
