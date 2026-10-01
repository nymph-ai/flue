/**
 * The public conversation wire served from the canonical Pi log
 * (PI_UPGRADE_PLAN.md §4, §7 step 7): a `ConversationProjectionSource` that
 * reads the log from a client's offset, projects each `PiCommitEnvelope`
 * (`projection.ts`), and returns the log's own opaque `nextOffset`.
 *
 * Fold cache: one resident projection state per `(log, path)` at the head,
 * plus the states at the last offsets this process served (clients resume
 * from exactly those). The log has no per-message offsets, so a state at an
 * arbitrary older offset cannot be rebuilt; a client resuming from an offset
 * the cache no longer holds gets a `conversation-reset` carrying the head
 * snapshot instead — the SDK's existing re-hydration path. Every state is a
 * cache of the log, never authoritative.
 */
import type { ConversationStreamChunk } from '../conversation-public.ts';
import type {
	ConversationHead,
	ConversationProjectionSource,
	ConversationRead,
	ConversationSourceMeta,
	ResetWindowProjector,
} from '../runtime/conversation-source.ts';
import { type DurableStreamLog, DurableStreamLogError } from '../streams/log.ts';
import { asStreamOffset, STREAM_START } from '../streams/offset.ts';
import { CommitAssembler } from './commit-envelope.ts';
import {
	cloneProjectionState,
	initialProjectionState,
	type PiProjectionState,
	projectPiCommitInPlace,
	projectPiLiveTargets,
	projectPiSnapshot,
} from './projection.ts';

/** Offsets whose states stay cached besides the head. */
const RECENT_OFFSETS = 32;
/** Head reads fold the log in pages of at most this many reads. */
const MAX_HEAD_READS = 10_000;

interface Folded {
	state: PiProjectionState;
	offset: string;
}

class PiProjectionHost implements ConversationProjectionSource {
	readonly #log: DurableStreamLog;
	readonly #path: string;
	#head: Folded = { state: initialProjectionState(), offset: STREAM_START };
	readonly #recent = new Map<string, PiProjectionState>();
	#chain: Promise<unknown> = Promise.resolve();

	constructor(log: DurableStreamLog, path: string) {
		this.#log = log;
		this.#path = path;
	}

	async meta(signal?: AbortSignal): Promise<ConversationSourceMeta | null> {
		const head = await this.#log.head(this.#path, signal);
		if (!head) return null;
		const folded = await this.#advance(signal);
		return { nextOffset: head.nextOffset, incarnation: incarnationOf(folded.state) };
	}

	async head(signal?: AbortSignal): Promise<ConversationHead> {
		const folded = await this.#advance(signal);
		const snapshot = projectPiSnapshot(folded.state, folded.offset);
		return {
			snapshot,
			liveTargets: projectPiLiveTargets(folded.state),
			offset: folded.offset,
			incarnation: incarnationOf(folded.state),
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
		const base = await this.#stateAt(from, options.signal);
		if (base === undefined) return this.#rehydrate(options.resetWindow, options.signal);
		let batch: Awaited<ReturnType<DurableStreamLog['read']>>;
		try {
			batch = await this.#log.read(this.#path, asStreamOffset(from), {
				...(options.live ? { live: options.live } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
		} catch (error) {
			if (options.signal?.aborted) return 'aborted';
			throw error;
		}
		if (options.signal?.aborted) return 'aborted';
		const state = cloneProjectionState(base);
		const chunks = foldMessages(state, batch.messages, options.resetWindow);
		this.#remember(batch.nextOffset, state);
		if (from === this.#head.offset && batch.nextOffset !== from) {
			this.#head = { state: cloneProjectionState(state), offset: batch.nextOffset };
		}
		return { chunks, nextOffset: batch.nextOffset, upToDate: batch.upToDate };
	}

	/** An offset this process no longer holds: re-hydrate from the head. */
	async #rehydrate(
		resetWindow: ResetWindowProjector | undefined,
		signal: AbortSignal | undefined,
	): Promise<ConversationRead> {
		const folded = await this.#advance(signal);
		const snapshot = projectPiSnapshot(folded.state, folded.offset);
		if (!snapshot) return { chunks: [], nextOffset: folded.offset, upToDate: true };
		const liveTargets = projectPiLiveTargets(folded.state);
		const chunk: ConversationStreamChunk = {
			type: 'conversation-reset',
			conversationId: snapshot.conversationId,
			snapshot: resetWindow ? resetWindow(snapshot, liveTargets) : snapshot,
			position: { batch: folded.state.seq, index: 0 },
		};
		return { chunks: [chunk], nextOffset: folded.offset, upToDate: true };
	}

	async #stateAt(
		from: string,
		signal: AbortSignal | undefined,
	): Promise<PiProjectionState | undefined> {
		if (from === STREAM_START) return initialProjectionState();
		const folded = await this.#advance(signal);
		if (from === folded.offset) return folded.state;
		return this.#recent.get(from);
	}

	#remember(offset: string, state: PiProjectionState): void {
		this.#recent.delete(offset);
		this.#recent.set(offset, state);
		while (this.#recent.size > RECENT_OFFSETS) {
			const oldest = this.#recent.keys().next().value;
			if (oldest === undefined) break;
			this.#recent.delete(oldest);
		}
	}

	/** Fold everything published since the cached head. Serialized. */
	#advance(signal: AbortSignal | undefined): Promise<Folded> {
		const operation = this.#chain.then(() => this.#advanceNow(signal));
		this.#chain = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	async #advanceNow(signal: AbortSignal | undefined): Promise<Folded> {
		const head = await this.#log.head(this.#path, signal);
		if (!head) {
			this.#head = { state: initialProjectionState(), offset: STREAM_START };
			this.#recent.clear();
			return this.#head;
		}
		let { offset } = this.#head;
		let state: PiProjectionState | undefined;
		for (let reads = 0; reads < MAX_HEAD_READS; reads++) {
			if (offset === head.nextOffset) break;
			let batch: Awaited<ReturnType<DurableStreamLog['read']>>;
			try {
				batch = await this.#log.read(this.#path, asStreamOffset(offset), signal ? { signal } : {});
			} catch (error) {
				if (error instanceof DurableStreamLogError && error.code === 'not-found') break;
				throw error;
			}
			if (batch.messages.length > 0) {
				state ??= cloneProjectionState(this.#head.state);
				const before = state.storage;
				foldMessages(state, batch.messages, undefined);
				if (before !== undefined && state.storage !== before) {
					// The log was recreated under us: start over from its beginning.
					this.#head = { state: initialProjectionState(), offset: STREAM_START };
					this.#recent.clear();
					return this.#advanceNow(signal);
				}
			}
			offset = batch.nextOffset;
			if (batch.upToDate) break;
		}
		if (state) {
			this.#head = { state, offset };
			this.#remember(offset, cloneProjectionState(state));
		} else if (offset !== this.#head.offset) {
			this.#head = { state: this.#head.state, offset };
		}
		return this.#head;
	}
}

function incarnationOf(state: PiProjectionState): string {
	return state.storage ?? 'pending';
}

/** Fold the log messages of one read into `state`; returns their chunks. */
function foldMessages(
	state: PiProjectionState,
	messages: readonly unknown[],
	resetWindow: ResetWindowProjector | undefined,
): ConversationStreamChunk[] {
	const assembler = new CommitAssembler();
	const chunks: ConversationStreamChunk[] = [];
	for (const message of messages) {
		const envelope = assembler.accept(message);
		if (!envelope) continue;
		if (state.storage !== undefined && envelope.storage !== state.storage) {
			// A different log generation: stop folding; the caller resets.
			state.storage = envelope.storage;
			return chunks;
		}
		if (envelope.seq <= state.seq) continue;
		for (const chunk of projectPiCommitInPlace(state, envelope)) {
			chunks.push(
				chunk.type === 'conversation-reset' && resetWindow
					? { ...chunk, snapshot: resetWindow(chunk.snapshot, projectPiLiveTargets(state)) }
					: chunk,
			);
		}
	}
	return chunks;
}

const hostsByLog = new WeakMap<DurableStreamLog, Map<string, PiProjectionHost>>();
const MAX_HOSTS = 64;

/** The shared projection source for one instance's Pi log. */
export function piConversationSource(
	log: DurableStreamLog,
	path: string,
): ConversationProjectionSource {
	let hosts = hostsByLog.get(log);
	if (!hosts) {
		hosts = new Map();
		hostsByLog.set(log, hosts);
	}
	const existing = hosts.get(path);
	if (existing) {
		hosts.delete(path);
		hosts.set(path, existing);
		return existing;
	}
	const host = new PiProjectionHost(log, path);
	hosts.set(path, host);
	while (hosts.size > MAX_HOSTS) {
		const oldest = hosts.keys().next().value;
		if (oldest === undefined || oldest === path) break;
		hosts.delete(oldest);
	}
	return host;
}
