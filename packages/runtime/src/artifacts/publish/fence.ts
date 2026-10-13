/**
 * Producer fencing for artifact semantic events (live-artifacts A6).
 *
 * Electric's HTTP producer headers are optional on the wire. This module
 * stamps an equivalent durable contract into each event so a lost append
 * acknowledgement cannot create a second logical effect: consumers key on
 * `eventId`, and a stale epoch is rejected.
 */

export interface ProducerFence {
	readonly producerId: string;
	epoch: number;
	seq: number;
}

export interface FencedEvent {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly streamId: string;
	readonly type: string;
	readonly artifactId: string;
	readonly occurredAt: string;
	readonly producerId: string;
	readonly producerEpoch: number;
	readonly producerSeq: number;
	readonly semanticRevision: number;
	readonly payload: Record<string, unknown>;
}

export function createFence(producerId: string, epoch = 1): ProducerFence {
	return { producerId, epoch, seq: 0 };
}

/** Advance the fence and stamp one event. Seq is monotonic within an epoch. */
export function stampEvent(
	fence: ProducerFence,
	input: {
		readonly eventId: string;
		readonly streamId: string;
		readonly type: string;
		readonly artifactId: string;
		readonly occurredAt: string;
		readonly semanticRevision: number;
		readonly payload: Record<string, unknown>;
	},
): FencedEvent {
	fence.seq += 1;
	return {
		schemaVersion: 1,
		eventId: input.eventId,
		streamId: input.streamId,
		type: input.type,
		artifactId: input.artifactId,
		occurredAt: input.occurredAt,
		producerId: fence.producerId,
		producerEpoch: fence.epoch,
		producerSeq: fence.seq,
		semanticRevision: input.semanticRevision,
		payload: input.payload,
	};
}

export class StaleEpochError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StaleEpochError';
	}
}
