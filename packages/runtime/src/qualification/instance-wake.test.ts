/**
 * #3752 through `FlueAgentInstance` — the core both coordinators run — rather
 * than a hand-assembled host: an entity that has never been opened is rung by
 * a message from another entity, pumped by its wake, renders its agent
 * function, and answers.
 *
 * Regression: the entity runtime admitted inbox messages without rendering
 * first, so an entity woken for the first time ran its turn with no model
 * ("No model is configured", found live on the society deployment).
 */
import { fauxProvider, type Message } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	answer,
	context,
	readAll,
	removeTempFiles,
	tempFile,
	TestWorld,
	textOf,
	toolCall,
} from '../entity/a2a-test-support.ts';
import { inboxPath } from '../entity/paths.ts';
import { useModel } from '../hooks/use-model.ts';
import { createMcpConnectionCache } from '../mcp.ts';
import { openNodeSqliteDatabase } from '../node/node-sqlite-database.ts';
import type { WakeReason } from '../pi/host.ts';
import { FlueAgentInstance } from '../runtime/agent-instance.ts';
import { InMemoryAttachmentStore } from '../runtime/attachment-store.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import { resetModelsForTests, setProvider } from '../runtime/providers.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import type { Agent } from '../types.ts';

const instances: FlueAgentInstance[] = [];
const worlds: TestWorld[] = [];

afterEach(async () => {
	for (const instance of instances) await instance.close().catch(() => {});
	for (const world of worlds) await world.closeAll().catch(() => {});
	instances.length = 0;
	worlds.length = 0;
	resetModelsForTests();
	await removeTempFiles();
});

function bobResponder(messages: readonly Message[]) {
	const last = messages.findLast((message) => message.role !== 'system');
	if (last?.role === 'toolResult') return answer('Replied.');
	const text = messages
		.filter((message) => message.role === 'user')
		.map((message) => textOf(message))
		.join('\n');
	const from = /from_type="([^"]*)" from_id="([^"]*)"/.exec(text);
	return from
		? toolCall('send_message', { target: { type: from[1], id: from[2] }, text: 'pong' })
		: answer('ack');
}

describe('an entity woken for the first time (FlueAgentInstance)', () => {
	it('renders before it admits, runs Pi on the message and answers', async () => {
		const faux = fauxProvider({ provider: 'qual', models: [{ id: 'bob-1' }] });
		faux.setResponses(
			Array.from(
				{ length: 20 },
				() => (request: { messages: Message[] }) => bobResponder(request.messages),
			) as never,
		);
		setProvider(faux.provider);
		const Bob = (() => {
			useModel('qual/bob-1');
			return 'You are Bob.';
		}) as unknown as Agent;

		const log = new InMemoryDurableStreamLog();
		const world = new TestWorld(log);
		worlds.push(world);
		const alice = world.entity({ type: 'alice', id: 'a1' });
		const runtime = await alice.open();
		const sent = await runtime.messaging.send(
			{ type: 'bob', id: 'p/b1' },
			{ text: 'ping' },
			{ messageId: 'm1' },
			context,
		);

		const file = await tempFile('bob.sqlite');
		const wakes: WakeReason[] = [];
		const bob = new FlueAgentInstance({
			agentName: 'bob',
			instanceId: 'p/b1',
			agent: Bob,
			database: () => openNodeSqliteDatabase(file),
			attachments: new InMemoryAttachmentStore(),
			armWake: (_atMs, reason) => {
				wakes.push(reason);
			},
			events: { emitEvent: () => ({}) } as never,
			mcp: createMcpConnectionCache(),
			entities: { log },
		});
		instances.push(bob);
		const inbox = inboxPath({ type: 'bob', id: 'p/b1' });
		// The doorbell records the head and arms a wake; nothing is opened yet.
		await bob.ring(inbox, (await log.head(inbox))?.nextOffset ?? '-1');
		expect(wakes).toEqual([{ kind: 'pump' }]);
		const wake = await bob.wake({ kind: 'pump' });
		const submissionId = await deriveKeyedSubmissionId('bob', 'p/b1', 'm1');
		expect(sent.submissionId).toBe(submissionId);
		expect(wake).toMatchObject({ behind: false, pump: { admitted: [submissionId] } });
		const settlement = await (await bob.host()).waitForSettlement(submissionId, context);
		expect(settlement).toMatchObject({ outcome: 'completed' });
		await bob.waitForIdle();
		// Pi's commits never left the instance.
		expect(await log.head('flue/v1/bob/p%2Fb1/pi')).toBeNull();
		// The public conversation is served from the instance's own cache.
		const head = await bob.source.head();
		expect(head.snapshot?.messages.map((message) => message.role)).toEqual(['system', 'assistant']);
		expect(await readAll(log, inboxPath({ type: 'alice', id: 'a1' }))).toEqual([
			expect.objectContaining({
				type: 'flue.a2a.message',
				from: { type: 'bob', id: 'p/b1' },
				message: { text: 'pong' },
			}),
		]);
	});
});
