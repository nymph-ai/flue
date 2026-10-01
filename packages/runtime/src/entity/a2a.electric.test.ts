/**
 * The #3752 A2A scenario against a real Durable Streams server: the relay
 * POSTs through `ElectricDurableStreamLog`, the server's webhook
 * subscriptions (`createEntitySubscriptions`) sign and deliver real wakes to
 * the Worker route served over HTTP, verified against the server's JWKS.
 *
 * Skipped unless `FLUE_DS_URL` names the server's stream root (`…/v1/stream`);
 * `scripts/test-durable-streams-server.sh` starts the Node reference server
 * (the one Electric's agents-server embeds) and runs this file.
 *
 * Not covered here: the agents-server itself (it needs Postgres). Its wake
 * format and callback are covered by `webhook.test.ts` and `a2a.test.ts`
 * against the shapes its source produces.
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Message } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { openStreamStorage, removeTempFiles, snapshotReads, tempFile } from '../pi/stream-storage-test-support.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import { ElectricDurableStreamLog } from '../streams/electric-log.ts';
import {
	answer,
	context,
	eventually,
	lastMessage,
	readAll,
	type TestEntity,
	TestWorld,
	textOf,
	toolCall,
} from './a2a-test-support.ts';
import { inboxPath, observeSubscriptionId } from './paths.ts';
import type { EntityRef } from './services.ts';
import { createEntitySubscriptions } from './subscriptions.ts';
import { createEntityWakeRoute } from './webhook-route.ts';
import { jwksWebhookKeys, webhookJwksUrl } from './webhook.ts';

const env =
	(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const realServer = env.FLUE_DS_URL;

async function startRoute(world: TestWorld, root: string, reports: unknown[]) {
	const route = createEntityWakeRoute({
		keys: jwksWebhookKeys({ url: webhookJwksUrl(root) }),
		wake: world.wake,
		onReport: (error) => reports.push(error),
	});
	let resolveInfo: (info: AddressInfo) => void = () => {};
	const listening = new Promise<AddressInfo>((resolve) => {
		resolveInfo = resolve;
	});
	const server = serve({ fetch: route.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolveInfo(info));
	const info = await listening;
	return {
		url: `http://127.0.0.1:${info.port}/__flue/streams/wake`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** Wait for a submission the webhook path admits on its own schedule, then for it to settle. */
async function settled(entity: TestEntity, submissionId: string): Promise<string> {
	const settlement = await eventually(
		async () => (entity.host ? await entity.host.settlement(submissionId, context) : undefined),
		{ what: `${entity.ref.id} to settle ${submissionId}`, timeoutMs: 30_000 },
	);
	return settlement.outcome;
}

async function deleteSubscription(root: string, id: string): Promise<void> {
	await fetch(`${root}/__ds/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

describe.skipIf(!realServer)('A2A entities against FLUE_DS_URL', () => {
	it('Alice messages sleeping Bob through real webhook wakes; both histories replay from the server', async () => {
		const root = realServer as string;
		const run = crypto.randomUUID().slice(0, 8);
		const ALICE: EntityRef = { type: `agent-${run}`, id: 'alice' };
		const BOB: EntityRef = { type: `agent-${run}`, id: 'bob' };
		const log = new ElectricDurableStreamLog({ baseUrl: root });
		const world = new TestWorld(log);
		const reports: unknown[] = [];
		const route = await startRoute(world, root, reports);
		const subscriptions = createEntitySubscriptions({
			root,
			webhookUrl: route.url,
			inboxSubscriptionId: `flue-inbox-${run}`,
		});
		try {
			await subscriptions.ensureInbox();
			world.subscriptions = subscriptions;
			const alice = world.entity(ALICE, (messages: readonly Message[]) => {
				const last = lastMessage(messages);
				if (last?.role === 'toolResult') return answer('Asked Bob.');
				const text = textOf(last);
				if (text.includes('pong')) return answer('Bob answered pong.');
				if (text.includes('ask bob')) return toolCall('send_message', { target: BOB, text: 'ping' });
				return answer('ok');
			});
			const bob = world.entity(BOB, (messages: readonly Message[]) => {
				const last = lastMessage(messages);
				if (last?.role === 'toolResult') return answer('Replied to Alice.');
				if (textOf(last).includes('ping')) return toolCall('send_message', { target: ALICE, text: 'pong' });
				return answer('ok');
			});

			await alice.open();
			await alice.requireHost().admit(
				{
					submissionId: 'sub_ask',
					kind: 'dispatch',
					message: { kind: 'user', body: 'please ask bob' },
					acceptedAt: new Date().toISOString(),
					whenBusy: 'followUp',
				},
				context,
			);
			expect((await alice.requireHost().waitForSettlement('sub_ask', context)).outcome).toBe('completed');
			await alice.flush();

			// Bob is asleep until the server's webhook wakes him.
			const [ping] = await eventually(async () => {
				const inbox = await readAll(log, inboxPath(BOB));
				return inbox.length > 0 ? inbox : undefined;
			});
			const bobSubmission = await deriveKeyedSubmissionId(BOB.type, BOB.id, (ping as { messageId: string }).messageId);
			expect(await settled(bob, bobSubmission)).toBe('completed');
			await bob.flush();

			const [pong] = await eventually(async () => {
				const inbox = await readAll(log, inboxPath(ALICE));
				return inbox.length > 0 ? inbox : undefined;
			});
			const aliceSubmission = await deriveKeyedSubmissionId(
				ALICE.type,
				ALICE.id,
				(pong as { messageId: string }).messageId,
			);
			expect(await settled(alice, aliceSubmission)).toBe('completed');
			await alice.flush();
			expect(world.woken.map((wake) => wake.entity)).toEqual(
				expect.arrayContaining([`${ALICE.type}/bob`, `${ALICE.type}/alice`]),
			);

			const histories = new Map<TestEntity, unknown[]>();
			for (const entity of [alice, bob]) histories.set(entity, await entity.entries());
			await world.closeAll();
			await alice.open();
			await bob.open();
			for (const entity of [alice, bob]) {
				const before = histories.get(entity) ?? [];
				expect((await entity.entries()).slice(0, before.length)).toEqual(before);
				await entity.flush();
				const seq = entity.lastSeq();
				const reads = await snapshotReads(entity.requireStorage(), seq);
				const rebuilt = await openStreamStorage({ file: await tempFile(), log, entity: entity.ref });
				try {
					expect(await snapshotReads(rebuilt.storage, seq)).toEqual(reads);
				} finally {
					await rebuilt.storage.close(context);
				}
			}
			expect(await readAll(log, inboxPath(BOB))).toHaveLength(1);
			expect(await readAll(log, inboxPath(ALICE))).toHaveLength(1);
			expect(alice.fences).toEqual([]);
			expect(bob.fences).toEqual([]);
		} finally {
			await deleteSubscription(root, `flue-inbox-${run}`);
			await world.closeAll().catch(() => {});
			await route.close();
			await removeTempFiles();
		}
	}, 60_000);

	it('an observed world stream wakes only its observer through its own subscription', async () => {
		const root = realServer as string;
		const run = crypto.randomUUID().slice(0, 8);
		const ALICE: EntityRef = { type: `observer-${run}`, id: 'alice' };
		const BOB: EntityRef = { type: `observer-${run}`, id: 'bob' };
		const log = new ElectricDurableStreamLog({ baseUrl: root });
		const world = new TestWorld(log);
		const reports: unknown[] = [];
		const route = await startRoute(world, root, reports);
		world.subscriptions = createEntitySubscriptions({ root, webhookUrl: route.url });
		const stream = `world-${run}/hn/items`;
		try {
			await log.ensure(stream);
			const alice = world.entity(ALICE);
			const bob = world.entity(BOB);
			const runtime = await alice.open();
			await bob.open();
			await runtime.observation.observe({ stream }, { key: 'hn', wake: true }, context);
			const item = { type: 'society.observation', v: 1, source: 'rsshub', id: 'hn-1', title: 'Story 1' };
			const appended = await log.append(stream, { messages: [item], producer: { id: `rsshub-${run}`, epoch: 0, seq: 0 } });
			expect(appended.status).toBe('appended');
			const observed = await eventually(async () => {
				const entries = (await alice.entries()).filter((entry) => entry.kind === 'flue.observed');
				return entries.length > 0 ? entries : undefined;
			});
			expect(observed.map((entry) => entry.data)).toEqual([expect.objectContaining({ key: 'hn', stream, item })]);
			expect(world.woken.map((wake) => wake.entity)).toEqual([`${ALICE.type}/alice`]);
			expect((await bob.entries()).some((entry) => entry.kind === 'flue.observed')).toBe(false);
		} finally {
			await deleteSubscription(root, observeSubscriptionId(ALICE));
			await world.closeAll().catch(() => {});
			await route.close();
			await removeTempFiles();
		}
	}, 60_000);
});
