/**
 * Where the public conversation wire is projected from (PI_UPGRADE_PLAN.md
 * §4). The HTTP read routes and the in-process observers speak only this
 * interface, so they serve the Pi projection of the canonical log
 * (`pi/projection-host.ts`) and, for one release, a pre-upgrade record
 * stream (`legacy/conversation-source.ts`) with the same protocol.
 *
 * Offsets are the source's own opaque tokens (PROTOCOL §8): a client resumes
 * only from an offset a source minted.
 */
import type { AgentConversationSnapshot, ConversationStreamChunk } from '../conversation-public.ts';

export interface ConversationSourceMeta {
	/** The offset a read from the head would resume at. */
	readonly nextOffset: string;
	/** Durable generation identity; changes when the stream is recreated. */
	readonly incarnation: string;
}

export interface ConversationHead {
	/** `undefined` while the stream holds no conversation yet. */
	readonly snapshot: AgentConversationSnapshot | undefined;
	/** Message ids a bounded window must keep (`conversation-history-window.ts`). */
	readonly liveTargets: ReadonlySet<string>;
	readonly offset: string;
	readonly incarnation: string;
}

export interface ConversationRead {
	readonly chunks: ConversationStreamChunk[];
	readonly nextOffset: string;
	readonly upToDate: boolean;
}

/** Rewrites a `conversation-reset` snapshot against the live targets it was projected with. */
export type ResetWindowProjector = (
	snapshot: AgentConversationSnapshot,
	liveTargets: ReadonlySet<string>,
) => AgentConversationSnapshot;

export interface ConversationProjectionSource {
	/** `null` when the stream does not exist. */
	meta(signal?: AbortSignal): Promise<ConversationSourceMeta | null>;
	/** The materialized conversation at the head. */
	head(signal?: AbortSignal): Promise<ConversationHead>;
	/**
	 * Chunks strictly after `from`. `long-poll` waits (bounded) for data when
	 * there is none; `'aborted'` when `signal` fires first.
	 */
	read(
		from: string,
		options?: {
			readonly live?: 'long-poll';
			readonly signal?: AbortSignal;
			readonly resetWindow?: ResetWindowProjector;
		},
	): Promise<ConversationRead | 'aborted'>;
}
