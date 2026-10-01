/**
 * Test support: read an agent instance's public conversation through the
 * configured Node runtime (`start()`), the way clients see it. Imported only
 * by `*.test.ts`.
 */
import type { AgentConversationSnapshot } from '../conversation-public.ts';
import type { ConversationUiMessage } from '../conversation-projections.ts';
import type { Agent } from '../types.ts';
import { getFlueRuntime } from './flue-app.ts';
import { getRegisteredAgentIdentity } from './registration.ts';

/** The public history snapshot of `agent`'s instance `id`. */
export async function readConversation(
	agent: Agent,
	id: string,
): Promise<AgentConversationSnapshot> {
	const runtime = getFlueRuntime();
	if (runtime?.target !== 'node')
		throw new Error('readConversation() needs the Node runtime (start()).');
	const name = getRegisteredAgentIdentity(agent);
	if (!name) throw new Error('readConversation(): the agent is not registered.');
	const head = await (await runtime.conversationSource(name, id)).head();
	if (!head.snapshot) throw new Error(`readConversation(): ${name}/${id} has no conversation.`);
	return head.snapshot;
}

/** Every tool part of a snapshot, in order. */
export function toolParts(
	snapshot: AgentConversationSnapshot,
): Extract<ConversationUiMessage['parts'][number], { type: 'dynamic-tool' }>[] {
	return snapshot.messages.flatMap((message) =>
		message.parts.flatMap((part) => (part.type === 'dynamic-tool' ? [part] : [])),
	);
}
