/**
 * One-time import of a pre-upgrade conversation stream into Pi Durable
 * (PI_UPGRADE_PLAN.md §7 step 8). Kept for one release, then deleted with the
 * rest of `legacy/`.
 *
 * The legacy records are folded with the legacy reducer; the instance's root
 * conversation (the default session) then lands in ONE Pi commit:
 *
 * - its birth record (uid, creation time, creation data) as `flue.instance`,
 *   and its `usePersistentState` values as `flue.state`;
 * - its active transcript as Pi entries, so the model keeps its context:
 *   user and signal input as `pi.user`, answers as `pi.assistant`, tool
 *   outcomes as `pi.tool-result`, and the latest compaction summary as a
 *   `pi.reset` handoff that starts the model context;
 * - a `flue.import` marker carrying the legacy public projection (messages
 *   and settlements), which the Pi projection serves verbatim and announces
 *   with a `conversation-reset` — the SDK's re-hydration path, so clients
 *   holding pre-upgrade offsets resynchronize.
 *
 * Lossy by design: attachment bytes are not carried into model context
 * (the transcript keeps a placeholder line), in-flight work and unsettled
 * submissions are not resumed, and Flue-only advisories stay in the public
 * projection only.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import type { Message } from '@earendil-works/pi-ai';
import {
	AssistantEntry,
	type Harness,
	ResetEntry,
	ROOT_CONVERSATION_ID,
	ToolResultEntry,
	UserEntry,
} from '@earendil-works/pi-durable';
import { renderSignalMessage } from '../message-rendering.ts';
import { FlueInstance, FlueState } from '../pi/docs.ts';
import { ENTRY_IMPORT } from '../pi/projection.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { projectAgentConversationSnapshot } from './conversation-projection.ts';
import {
	getActiveConversationPath,
	type ReducedConversationState,
	type ReducedInstanceState,
} from './conversation-reducer.ts';
import { foldLegacyStream } from './conversation-source.ts';

const DEFAULT = 'default';

/** A strict-JSON copy: legacy values may carry `undefined` properties, which Pi rejects. */
function json<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function rootConversation(state: ReducedInstanceState): ReducedConversationState | undefined {
	const roots = [...state.conversations.values()].filter(
		(conversation) => conversation.kind === 'root',
	);
	return (
		roots.find(
			(conversation) => conversation.harness === DEFAULT && conversation.session === DEFAULT,
		) ?? roots[0]
	);
}

/** Model context of one legacy transcript message, in Pi's message shapes. */
function piMessage(message: unknown, timestamp: number): Message | undefined {
	const legacy = message as {
		role: string;
		content: unknown;
		type?: string;
		attributes?: Record<string, string>;
		tagName?: string;
	};
	if (legacy.role === 'signal') {
		return {
			role: 'user',
			content: [
				{
					type: 'text',
					text: renderSignalMessage({
						role: 'signal',
						type: legacy.type ?? 'signal',
						content: String(legacy.content ?? ''),
						...(legacy.attributes ? { attributes: legacy.attributes } : {}),
						...(legacy.tagName ? { tagName: legacy.tagName } : {}),
						timestamp,
					}),
				},
			],
			timestamp,
		};
	}
	if (legacy.role === 'user') {
		const content =
			typeof legacy.content === 'string'
				? legacy.content
				: (legacy.content as { type: string; text?: string; mimeType?: string }[]).map((block) =>
						block.type === 'text'
							? { type: 'text' as const, text: block.text ?? '' }
							: { type: 'text' as const, text: `[attachment: ${block.mimeType ?? 'file'}]` },
					);
		return { role: 'user', content, timestamp };
	}
	if (legacy.role === 'assistant' || legacy.role === 'toolResult') return message as Message;
	return undefined;
}

/**
 * Import `path`'s legacy stream into `harness` when the Pi side has no
 * instance yet. Returns whether anything was imported.
 */
export async function importLegacyConversation(options: {
	readonly harness: Harness;
	readonly store: ConversationStreamStore;
	readonly path: string;
	readonly context: Context;
}): Promise<boolean> {
	const { harness, store, path, context } = options;
	const born = await harness.snapshot(FlueInstance, context);
	if (born?.uid) return false;
	if (!(await store.getMeta(path))) return false;
	const state = await foldLegacyStream(store, path);
	const root = rootConversation(state);
	if (!root || state.uid === undefined) return false;
	const snapshot = projectAgentConversationSnapshot(state);
	const path_ = getActiveConversationPath(root);
	return harness.commit(async (tx) => {
		const instance = await tx.doc(FlueInstance);
		if (instance.uid !== null) return false;
		instance.uid = state.uid ?? null;
		instance.createdAt = path_[0]?.timestamp ?? new Date().toISOString();
		if (state.initialData !== undefined)
			instance.initialData = { value: json(state.initialData.value ?? null) as JsonValue };
		if (state.state.size > 0) {
			const values = await tx.doc(FlueState);
			for (const [name, value] of state.state) values.values[name] = json(value) as never;
		}
		for (const entry of path_) {
			const timestamp = Date.parse(entry.timestamp) || Date.now();
			if (entry.type === 'compaction') {
				await tx.appendEntry(ResetEntry, ROOT_CONVERSATION_ID, {
					head: 'self',
					model: json([{ role: 'user', content: entry.summary, timestamp }]),
				});
				continue;
			}
			const message = piMessage(entry.message, timestamp);
			if (!message) continue;
			const token =
				message.role === 'assistant'
					? AssistantEntry
					: message.role === 'toolResult'
						? ToolResultEntry
						: UserEntry;
			if (token === ToolResultEntry) {
				await tx.appendEntry(ToolResultEntry, ROOT_CONVERSATION_ID, {
					model: json([message]),
					data: { diagnostics: [] },
				});
			} else {
				await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: token.kind, model: json([message]) });
			}
		}
		await tx.appendEntry(ROOT_CONVERSATION_ID, {
			kind: ENTRY_IMPORT,
			data: {
				source: path,
				messages: json(snapshot?.messages ?? []) as unknown as JsonValue,
				settlements: json(snapshot?.settlements ?? []) as unknown as JsonValue,
			},
		});
		return true;
	}, context);
}
