/**
 * #3752 through `FlueAgentInstance` — the core both coordinators run — rather
 * than a hand-assembled host: an entity that has never been opened is woken
 * by a message from another entity, renders its agent function, and answers.
 *
 * Regressions: the entity runtime admitted inbox messages without rendering
 * first, so an entity woken for the first time ran its turn with no model
 * ("No model is configured", found live on the society deployment); and an instance whose id holds `/` (every
 * spawned child) kept its Pi log at an unencoded path, not at
 * `flue/v1/{agent}/{encoded id}/pi` where every reader looks.
 */
import { fauxProvider, type Message } from '@earendil-works/pi-ai';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { afterEach, describe, expect, it } from 'vitest';
import { answer, readAll, TestWorld, textOf, toolCall } from '../entity/a2a-test-support.ts';
import { inboxPath } from '../entity/paths.ts';
import { useModel } from '../hooks/use-model.ts';
import { createMcpConnectionCache } from '../mcp.ts';
import { context, removeTempFiles, tempFile } from '../pi/stream-storage-test-support.ts';
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
			Array.from({ length: 20 }, () => (request: { messages: Message[] }) => bobResponder(request.messages)) as never,
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
		const sent = await runtime.messaging.send({ type: 'bob', id: 'p/b1' }, { text: 'ping' }, { messageId: 'm1' }, context);
		await alice.flush();

		const file = await tempFile('bob.sqlite');
		const bob = new FlueAgentInstance({
			agentName: 'bob',
			instanceId: 'p/b1',
			agent: Bob,
			database: () => openNodeSqliteDatabase(file),
			log,
			publish: 'await',
			attachments: new InMemoryAttachmentStore(),
			armWake: () => {},
			events: { emitEvent: () => ({}) } as never,
			mcp: createMcpConnectionCache(),
			entities: {},
		});
		instances.push(bob);
		const inbox = inboxPath({ type: 'bob', id: 'p/b1' });
		const wake = await bob.wakeEntity({
			subscriptionId: 'flue-inbox',
			generation: 1,
			streams: [{ path: inbox, tailOffset: (await log.head(inbox))?.nextOffset ?? '-1' }],
		});
		const submissionId = await deriveKeyedSubmissionId('bob', 'p/b1', 'm1');
		expect(sent.submissionId).toBe(submissionId);
		expect(wake.admitted).toEqual([submissionId]);
		const settlement = await (await bob.host()).waitForSettlement(submissionId, context);
		expect(settlement).toMatchObject({ outcome: 'completed' });
		await bob.waitForIdle();
		expect(bob.logPath).toBe('flue/v1/bob/p%2Fb1/pi');
		expect(await log.head('flue/v1/bob/p%2Fb1/pi')).not.toBeNull();
		expect(await log.head('flue/v1/bob/p/b1/pi')).toBeNull();
		expect(await readAll(log, inboxPath({ type: 'alice', id: 'a1' }))).toEqual([
			expect.objectContaining({ type: 'flue.a2a.message', from: { type: 'bob', id: 'p/b1' }, message: { text: 'pong' } }),
		]);
	});
});
