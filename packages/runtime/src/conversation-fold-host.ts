import { loadReducedConversationState } from './conversation-reader.ts';
import {
	type ReducedInstanceState,
	reduceConversationRecords,
	reduceConversationRecordsInPlace,
} from './conversation-reducer.ts';
import type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { compareOffsets } from './streams/offset.ts';

/**
 * One resident reduced-state fold per (store, path), shared by every reader
 * and by the instance's writer.
 *
 * Reads served from a host fold only the batches appended since the last
 * call instead of replaying the stream from the origin; the writer adopts
 * its post-append state into the same host, so on a warm instance the writer
 * and all readers reference a single state object.
 *
 * The host is fold-only: it never creates streams and never acquires the
 * producer, so a read can never fence out a live writer (acquiring the
 * producer bumps the epoch; on Node several processes hold claims over one
 * store). The cached state is exactly what a from-scratch
 * `loadReducedConversationState` produces at the same offset — including for
 * streams that do not exist, where both yield an empty state and callers
 * detect absence via `getMeta`, as today.
 *
 * Failure atomicity mirrors the writer's incremental path: new batches fold
 * into a clone and the reference swaps only on success, so a poisoned batch
 * fails the request loudly and leaves the cached state intact. Entries are
 * keyed by stream incarnation — a store that was wiped and regrown discards
 * the cached fold.
 */
export class ConversationFoldHost {
	private state: ReducedInstanceState | undefined;
	private incarnation: string | undefined;
	private chain: Promise<unknown> = Promise.resolve();
	private pins = 0;

	constructor(
		private readonly store: ConversationStreamStore,
		readonly path: string,
	) {}

	/**
	 * The reduced state at the durable head. Calls are serialized so
	 * concurrent readers share one advancement; the returned state is shared
	 * and must not be mutated — fold forward with the cloning reducer
	 * (`projectConversationRead` already does).
	 */
	getStateAtHead(): Promise<ReducedInstanceState> {
		const operation = this.chain.then(() => this.advanceToHead());
		this.chain = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	/**
	 * Adopt a post-append state from the instance's writer. Keeps the host at
	 * head without a store read and deduplicates residency: after an append,
	 * the writer's memoized state and the host's cached state are the same
	 * object. Ignored when the host already holds a strictly newer state.
	 */
	adoptState(state: ReducedInstanceState, incarnation: string): void {
		if (this.incarnation !== incarnation) {
			this.state = undefined;
			this.incarnation = incarnation;
		}
		if (
			!this.state ||
			compareOffsets(state.recordsThroughOffset, this.state.recordsThroughOffset) >= 0
		) {
			this.state = state;
		}
	}

	/** Pinned hosts (live writers) are exempt from registry eviction. */
	pin(): void {
		this.pins += 1;
	}

	unpin(): void {
		this.pins = Math.max(0, this.pins - 1);
	}

	get pinned(): boolean {
		return this.pins > 0;
	}

	private async advanceToHead(): Promise<ReducedInstanceState> {
		const meta = await this.store.getMeta(this.path);
		if (!meta) {
			// Mirror the from-scratch loader on a missing stream: an empty state,
			// not an error — callers detect absence via their own getMeta. Not
			// cached: the stream may be created (or recreated) at any time.
			this.state = undefined;
			this.incarnation = undefined;
			return loadReducedConversationState({ store: this.store, path: this.path });
		}
		if (this.incarnation !== meta.incarnation) {
			this.state = undefined;
			this.incarnation = meta.incarnation;
		}
		if (!this.state) {
			this.state = await loadReducedConversationState({ store: this.store, path: this.path });
			return this.state;
		}
		// Fold the suffix into a clone and swap on success. The first new batch
		// pays the failure-atomicity clone (reduceConversationRecords); the rest
		// of the window folds in place on that private clone. The base is
		// snapshotted with the cursor: the writer may adopt a newer state while
		// a read below awaits the store, and folding the window onto that
		// adopted state would re-apply its own batch.
		const base = this.state;
		let next: ReducedInstanceState | undefined;
		let offset = base.recordsThroughOffset;
		while (true) {
			const read = await this.store.read(this.path, { offset, limit: 1000 });
			for (const batch of read.batches) {
				if (next) {
					reduceConversationRecordsInPlace(next, batch.records, batch.offset);
				} else {
					next = reduceConversationRecords(base, batch.records, batch.offset);
				}
				offset = batch.offset;
			}
			if (read.upToDate) break;
		}
		// The writer may have adopted a newer state while this advance awaited
		// the store; keep whichever reflects more of the stream.
		if (
			next &&
			compareOffsets(next.recordsThroughOffset, this.state.recordsThroughOffset) > 0
		) {
			this.state = next;
		}
		return this.state;
	}
}

/**
 * Cap on cached folds without a live writer. Writer-pinned hosts are exempt
 * (Node already keeps one writer per touched path for the process lifetime);
 * the cap bounds read-only paths in many-instance processes. An evicted host
 * costs one from-scratch replay on the next read.
 */
const MAX_IDLE_HOSTS = 64;

const hostsByStore = new WeakMap<ConversationStreamStore, Map<string, ConversationFoldHost>>();

/**
 * The shared fold host for one instance's conversation stream. Keyed by store
 * instance and path, so every consumer of the same store — HTTP read routes,
 * in-process observers, and the instance's writer — shares one fold. Entries
 * are LRU-evicted past {@link MAX_IDLE_HOSTS}, except hosts pinned by a live
 * writer.
 */
export function getConversationFoldHost(
	store: ConversationStreamStore,
	path: string,
): ConversationFoldHost {
	let hosts = hostsByStore.get(store);
	if (!hosts) {
		hosts = new Map();
		hostsByStore.set(store, hosts);
	}
	const existing = hosts.get(path);
	if (existing) {
		hosts.delete(path);
		hosts.set(path, existing);
		return existing;
	}
	const host = new ConversationFoldHost(store, path);
	hosts.set(path, host);
	if (hosts.size > MAX_IDLE_HOSTS) {
		for (const [key, candidate] of hosts) {
			if (candidate.pinned || candidate === host) continue;
			hosts.delete(key);
			break;
		}
	}
	return host;
}
