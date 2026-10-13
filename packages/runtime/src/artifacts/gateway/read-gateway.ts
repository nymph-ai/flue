/**
 * Streaming read gateway contract (P22-A5).
 *
 * Serves snapshot+cursor bootstrap and resumable SSE without waking AgentDO.
 */

import type { ArtifactReadModelSnapshot } from '../types.ts';

export interface ReadGatewayBootstrap {
	snapshot: ArtifactReadModelSnapshot;
	cursor: string;
}

export interface ReadGatewayPort {
	/** Atomic snapshot + opaque cursor for a scoped viewer token. */
	bootstrap(artifactId: string, viewerToken: string): Promise<ReadGatewayBootstrap>;
	/** Follow stream after cursor; implementation uses Electric durable streams. */
	follow(
		artifactId: string,
		cursor: string,
		viewerToken: string,
		signal?: AbortSignal,
	): AsyncIterable<unknown>;
}
