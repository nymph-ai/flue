/**
 * Deterministic artifact read-model reducer (P22-A5 / A6).
 *
 * Idempotent on eventId. Duplicate delivery, retries after a lost append
 * ack, and out-of-order arrival within one epoch converge to one state.
 * A lower producer epoch than the one already applied is rejected.
 */

import { StaleEpochError, type FencedEvent } from '../publish/fence.ts';
import type { ArtifactReadModelSnapshot } from '../types.ts';

export interface ReduceResult {
	readonly snapshot: ArtifactReadModelSnapshot;
	readonly applied: number;
	readonly duplicates: number;
	readonly gap: boolean;
}

export function emptySnapshot(artifactId: string, now: string): ArtifactReadModelSnapshot {
	return {
		schemaVersion: 1,
		artifactId,
		readModelRevision: 0,
		state: {},
		cursor: '0000000000000000_0000000000000000',
		materializedAt: now,
	};
}

export function reduceArtifactEvents(
	prior: ArtifactReadModelSnapshot,
	events: readonly FencedEvent[],
	options: { readonly cursor: string; readonly now: string },
): ReduceResult {
	const appliedIds = new Set<string>(
		Array.isArray(prior.state.appliedEventIds) ? (prior.state.appliedEventIds as string[]) : [],
	);
	let epoch = typeof prior.state.producerEpoch === 'number' ? prior.state.producerEpoch : 0;
	let revision = prior.readModelRevision;
	let duplicates = 0;
	let applied = 0;
	let gap = false;
	let expectedSeq = typeof prior.state.producerSeq === 'number' ? prior.state.producerSeq : 0;
	const state: Record<string, unknown> = { ...prior.state };

	const ordered = [...events].sort((a, b) => a.semanticRevision - b.semanticRevision || a.producerSeq - b.producerSeq);

	for (const event of ordered) {
		if (appliedIds.has(event.eventId)) {
			duplicates += 1;
			continue;
		}
		if (event.producerEpoch < epoch) {
			throw new StaleEpochError(
				`stale producer epoch ${event.producerEpoch} < ${epoch} for ${event.eventId}`,
			);
		}
		if (event.producerEpoch > epoch) {
			epoch = event.producerEpoch;
			expectedSeq = 0;
		}
		if (event.producerSeq > expectedSeq + 1) {
			gap = true;
		}
		expectedSeq = Math.max(expectedSeq, event.producerSeq);
		appliedIds.add(event.eventId);
		revision += 1;
		applied += 1;
		applyPayload(state, event);
	}

	state.appliedEventIds = [...appliedIds].sort();
	state.producerEpoch = epoch;
	state.producerSeq = expectedSeq;

	return {
		snapshot: {
			...prior,
			readModelRevision: revision,
			state,
			cursor: options.cursor,
			materializedAt: options.now,
			...(ordered.length > 0 ? { lastEventId: ordered[ordered.length - 1]!.eventId } : {}),
		},
		applied,
		duplicates,
		gap,
	};
}

function applyPayload(state: Record<string, unknown>, event: FencedEvent): void {
	if (event.type === 'artifact.state.updated') {
		const patch = event.payload.patch;
		if (patch && typeof patch === 'object') {
			Object.assign(state, patch as Record<string, unknown>);
		}
	}
	if (event.type === 'artifact.published') {
		state.publishedRevision = event.payload.revisionId;
		state.bundleDigest = event.payload.bundleDigest;
	}
	if (event.type === 'artifact.revoked') {
		state.revoked = true;
	}
}
