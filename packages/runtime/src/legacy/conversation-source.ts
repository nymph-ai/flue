/**
 * A pre-upgrade record stream as a `ConversationProjectionSource`, so the
 * read routes keep serving a stream written before the Pi cutover with the
 * same wire (PI_UPGRADE_PLAN.md §7 step 8). The fold is from scratch on every
 * read — legacy streams are frozen once their instance is imported into Pi —
 * and live reads poll the store. Kept one release with `legacy/import.ts`.
 */
import type {
	ConversationHead,
	ConversationProjectionSource,
	ConversationRead,
	ConversationSourceMeta,
	ResetWindowProjector,
} from '../runtime/conversation-source.ts';
import type {
	ConversationStreamBatch,
	ConversationStreamStore,
} from '../runtime/conversation-stream-store.ts';
import { legacyOffsetOrdinal } from '../runtime/stream-offsets.ts';
import {
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
	projectLiveMessageTargets,
} from './conversation-projection.ts';
import {
	createReducedInstanceState,
	type ReducedInstanceState,
	reduceConversationRecords,
	reduceConversationRecordsInPlace,
} from './conversation-reducer.ts';

const LONG_POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/** Fold a record stream through `offset` (every batch when omitted). */
export async function foldLegacyStream(
	store: ConversationStreamStore,
	path: string,
	through?: string,
): Promise<ReducedInstanceState> {
	const state = createReducedInstanceState();
	if (through === '-1') return state;
	let offset = '-1';
	while (true) {
		const read = await store.read(path, { offset, limit: 1000 });
		for (const batch of read.batches) {
			reduceConversationRecordsInPlace(state, batch.records, batch.offset);
			offset = batch.offset;
			if (through !== undefined && offset === through) return state;
		}
		if (read.upToDate) {
			if (through !== undefined) {
				throw new Error('[flue] Canonical conversation offset is not a batch boundary.');
			}
			return state;
		}
	}
}

function batchOrdinal(batch: ConversationStreamBatch): number {
	if (batch.ordinal !== undefined) return batch.ordinal;
	const legacy = legacyOffsetOrdinal(batch.offset);
	if (legacy !== undefined) return legacy;
	throw new Error(
		`[flue] Conversation stream batch at offset "${batch.offset}" carries no ordinal. A ConversationStreamStore whose offsets are not the formatOffset() shape must set ConversationStreamBatch.ordinal.`,
	);
}

class LegacyConversationSource implements ConversationProjectionSource {
	constructor(
		private readonly store: ConversationStreamStore,
		private readonly path: string,
	) {}

	async meta(): Promise<ConversationSourceMeta | null> {
		const meta = await this.store.getMeta(this.path);
		return meta ? { nextOffset: meta.nextOffset, incarnation: meta.incarnation } : null;
	}

	async head(): Promise<ConversationHead> {
		const meta = await this.store.getMeta(this.path);
		const state = await foldLegacyStream(this.store, this.path);
		return {
			snapshot: projectAgentConversationSnapshot(state),
			liveTargets: projectLiveMessageTargets(state),
			offset: state.recordsThroughOffset,
			incarnation: meta?.incarnation ?? '',
		};
	}

	async read(
		from: string,
		options: {
			readonly live?: 'long-poll';
			readonly signal?: AbortSignal;
			readonly resetWindow?: ResetWindowProjector;
		} = {},
	): Promise<ConversationRead | 'aborted'> {
		let state = await foldLegacyStream(this.store, this.path, from);
		const deadline = Date.now() + LONG_POLL_TIMEOUT_MS;
		let read = await this.store.read(this.path, { offset: from });
		while (options.live === 'long-poll' && read.batches.length === 0 && Date.now() < deadline) {
			if (options.signal?.aborted) return 'aborted';
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			read = await this.store.read(this.path, { offset: from });
		}
		if (options.signal?.aborted) return 'aborted';
		const chunks = [];
		for (const batch of read.batches) {
			const previousState = state;
			state = reduceConversationRecords(state, batch.records, batch.offset);
			const projected = projectAgentConversationBatch({
				state,
				previousState,
				records: batch.records,
				batchOrdinal: batchOrdinal(batch),
			});
			for (const chunk of projected) {
				chunks.push(
					chunk.type === 'conversation-reset' && options.resetWindow
						? {
								...chunk,
								snapshot: options.resetWindow(chunk.snapshot, projectLiveMessageTargets(state)),
							}
						: chunk,
				);
			}
		}
		return { chunks, nextOffset: read.nextOffset, upToDate: read.upToDate };
	}
}

/** The projection source of a pre-upgrade conversation record stream. */
export function legacyConversationSource(
	store: ConversationStreamStore,
	path: string,
): ConversationProjectionSource {
	return new LegacyConversationSource(store, path);
}
