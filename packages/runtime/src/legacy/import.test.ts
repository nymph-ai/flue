/**
 * The one-time import of a pre-upgrade conversation stream into Pi Durable
 * (PI_UPGRADE_PLAN.md §7 step 8), on record streams the legacy loop wrote
 * (`golden/fixtures/*.legacy-records.json`, recorded before the cutover).
 */
import { fauxAssistantMessage, fauxProvider, type Message } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { PersistenceAdapter } from '../agent-execution-store.ts';
import abortRecords from '../golden/fixtures/abort.legacy-records.json' with { type: 'json' };
import joinRecords from '../golden/fixtures/join-steer.legacy-records.json' with { type: 'json' };
import toolRecords from '../golden/fixtures/tool-calls.legacy-records.json' with { type: 'json' };
import { init, useModel } from '../index.ts';
import { start } from '../node/index.ts';
import { InMemoryAttachmentStore } from '../runtime/attachment-store.ts';
import {
	type ConversationStreamStore,
	InMemoryConversationStreamStore,
} from '../runtime/conversation-stream-store.ts';
import { getFlueRuntime } from '../runtime/flue-app.ts';
import { agentStreamPath } from '../runtime/stream-offsets.ts';
import type { ConversationRecord } from './conversation-records.ts';
import { legacyConversationSource } from './conversation-source.ts';

/**
 * A persistence adapter whose stream store already holds `batches` at
 * `path`, as a pre-upgrade store would. Each record is appended on its own,
 * under its own submission attempt: the store checks record ownership, and
 * the legacy loop's joined-delivery authorizations lived in the submission
 * table this runtime no longer writes.
 */
function preloadedDatabase(path: string, batches: readonly (readonly unknown[])[]) {
	const store = new InMemoryConversationStreamStore();
	const adapter: PersistenceAdapter = {
		async connect() {
			const [, agentName, instanceId] = path.split('/');
			await store.createStream(path, { agentName: agentName ?? '', instanceId: instanceId ?? '' });
			const producer = await store.acquireProducer(path, 'legacy-writer');
			let sequence = 0;
			for (const record of batches.flat() as ConversationRecord[]) {
				await store.append({
					path,
					producerId: producer.producerId,
					producerEpoch: producer.producerEpoch,
					incarnation: producer.incarnation,
					producerSequence: sequence++,
					...(record.submissionId !== undefined && record.attemptId !== undefined
						? { submission: { submissionId: record.submissionId, attemptId: record.attemptId } }
						: {}),
					records: [record],
				});
			}
			return { conversationStreamStore: store, attachmentStore: new InMemoryAttachmentStore() };
		},
	};
	return { adapter, store: () => store as ConversationStreamStore };
}

function strip(snapshot: unknown) {
	const {
		offset: _offset,
		incarnation: _incarnation,
		conversationId: _conversationId,
		...rest
	} = snapshot as Record<string, unknown>;
	return rest;
}

const cases: [string, readonly (readonly unknown[])[], string][] = [
	['tool-calls', toolRecords, 'ToolCalls'],
	['join-steer', joinRecords, 'JoinSteer'],
	['abort', abortRecords, 'Abort'],
];

describe('legacy conversation import', () => {
	for (const [name, batches, agentName] of cases) {
		it(
			`serves the ${name} history unchanged and continues the conversation on Pi`,
			{ timeout: 30_000 },
			async () => {
				const id = `golden-${name}`;
				const path = agentStreamPath(agentName, id);
				const requests: Message[][] = [];
				function Agent() {
					useModel('faux/model');
					return 'Continue the imported conversation.';
				}
				Object.defineProperty(Agent, 'name', { value: agentName });
				const faux = fauxProvider({ models: [{ id: 'model' }] });
				faux.setResponses([
					(context: { messages: Message[] }) => {
						requests.push(context.messages);
						return fauxAssistantMessage('Picked up where we left off.');
					},
				]);
				const database = preloadedDatabase(path, batches);
				const flue = await start({
					agents: [Agent],
					db: database.adapter,
					providers: [faux.provider],
					env: {},
				});
				try {
					const legacy = await legacyConversationSource(database.store(), path).head();
					const runtime = getFlueRuntime();
					if (runtime?.target !== 'node') throw new Error('expected the node runtime');
					const source = await runtime.conversationSource(agentName, id);
					const imported = await source.head();
					expect(strip(imported.snapshot)).toEqual(strip(legacy.snapshot));

					// SDK clients holding pre-upgrade offsets re-hydrate from a reset.
					const read = await source.read('-1');
					if (read === 'aborted') throw new Error('unexpected abort');
					const resets = read.chunks.filter((chunk) => chunk.type === 'conversation-reset');
					expect(resets.length).toBeGreaterThan(0);
					const last = resets.at(-1);
					expect(last?.type === 'conversation-reset' ? strip(last.snapshot) : undefined).toEqual(
						strip(legacy.snapshot),
					);

					// The instance kept its identity and its model context.
					const handle = init(Agent, { id });
					const legacyUid = (batches[0]?.[0] as { uid?: string } | undefined)?.uid;
					const receipt = await handle.dispatch('Where were we?');
					expect(receipt.uid).toBe(legacyUid);
					await expect(handle.read(receipt)).resolves.toMatchObject({
						text: 'Picked up where we left off.',
					});
					const firstUser = legacy.snapshot?.messages.find(
						(message) => message.role !== 'assistant',
					);
					const firstText = firstUser?.parts.find((part) => part.type === 'text');
					expect(JSON.stringify(requests.at(-1))).toContain(
						firstText && 'text' in firstText ? firstText.text : '<missing>',
					);
				} finally {
					await flue.stop();
				}
			},
		);
	}
});
