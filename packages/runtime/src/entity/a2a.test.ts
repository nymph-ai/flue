/**
 * The A2A entity layer end to end, in process: InMemoryDurableStreamLog +
 * Pi's SqliteStorage on node:sqlite + real FluePiHosts on pi-ai's faux
 * provider, with wakes delivered as Ed25519-signed webhooks through the
 * Worker route, rung as doorbells, and pumped by alarms
 * (docs/cloudflare-native.md rules 2–5).
 *
 * The first test is the #3752 acceptance scenario.
 */
import type { Message } from '@earendil-works/pi-ai';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { afterEach, describe, expect, it } from 'vitest';
import { FlueInstance } from '../pi/docs.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import {
	agentsServerWakeBody,
	answer,
	context,
	durableStreamsWakeBody,
	lastMessage,
	readAll,
	removeTempFiles,
	type TestEntity,
	TestWorld,
	textOf,
	toolCall,
	WebhookSigner,
} from './a2a-test-support.ts';
import { spawnedUid } from './facet.ts';
import { relayedScheduleKey } from './inbox.ts';
import {
	entityKey,
	inboxPath,
	INBOX_SUBSCRIPTION_ID,
	observeSubscriptionId,
	wirePath,
} from './paths.ts';
import { scheduleSubmissionId } from './schedules.ts';
import type { EntityRef } from './services.ts';
import { ENTITY_TOOL_NAMES } from './tool-names.ts';
import { createEntityWakeRoute } from './webhook-route.ts';
import { staticWebhookKeys } from './webhook.ts';

const ALICE: EntityRef = { type: 'agent', id: 'alice' };
const BOB: EntityRef = { type: 'agent', id: 'bob' };
const WAKE_URL = 'https://flue.test/__flue/streams/wake';

function aliceResponder(messages: readonly Message[]) {
	const last = lastMessage(messages);
	if (last?.role === 'toolResult') return answer('Asked Bob.');
	const text = textOf(last);
	if (text.includes('pong')) return answer('Bob answered pong.');
	if (text.includes('ask bob')) return toolCall('send_message', { target: BOB, text: 'ping' });
	return answer('ok');
}

function bobResponder(messages: readonly Message[]) {
	const last = lastMessage(messages);
	if (last?.role === 'toolResult') return answer('Replied to Alice.');
	if (textOf(last).includes('ping'))
		return toolCall('send_message', { target: ALICE, text: 'pong' });
	return answer('ok');
}

/** What a reader of an entity's history sees, entry by entry. */
async function transcript(entity: TestEntity) {
	return (await entity.entries()).map((entry) => ({
		kind: entry.kind,
		text: textOf(entry.model?.[0]),
		data: entry.data ?? null,
	}));
}

interface Harness {
	readonly log: InMemoryDurableStreamLog;
	readonly world: TestWorld;
	readonly signer: WebhookSigner;
	readonly callbacks: { url: string; headers: Record<string, string>; body: unknown }[];
	callbackResponse: () => Response;
	deliver(body: string): Promise<{ status: number; json: Record<string, unknown> }>;
}

const worlds: TestWorld[] = [];

async function setup(
	log: InMemoryDurableStreamLog = new InMemoryDurableStreamLog(),
): Promise<Harness> {
	const world = new TestWorld(log);
	worlds.push(world);
	const signer = await WebhookSigner.create();
	const callbacks: Harness['callbacks'] = [];
	const harness: Harness = {
		log,
		world,
		signer,
		callbacks,
		callbackResponse: () => Response.json({ ok: true, next_wake: false }),
		async deliver(body) {
			const response = await route.fetch(await signer.request(WAKE_URL, body, world.clock.now));
			return { status: response.status, json: (await response.json()) as Record<string, unknown> };
		},
	};
	const route = createEntityWakeRoute({
		keys: staticWebhookKeys({ keys: [signer.jwk] }),
		wake: world.wake,
		now: () => world.clock.now,
		fetch: async (url, init) => {
			callbacks.push({
				url,
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				body: JSON.parse(String(init?.body)),
			});
			return harness.callbackResponse();
		},
	});
	return harness;
}

async function tail(log: DurableStreamLog, path: string): Promise<string> {
	const head = await log.head(path);
	if (!head) throw new Error(`no stream ${path}`);
	return head.nextOffset;
}

function inboxWake(generation: number, entity: EntityRef, tailOffset: string): string {
	return durableStreamsWakeBody({
		subscriptionId: INBOX_SUBSCRIPTION_ID,
		generation,
		streams: [{ path: inboxPath(entity), tailOffset }],
	});
}

afterEach(async () => {
	for (const world of worlds) await world.closeAll().catch(() => {});
	worlds.length = 0;
	await removeTempFiles();
});

describe('A2A entities (#3752 acceptance)', () => {
	it('Alice messages sleeping Bob; the doorbell and the alarm wake him; both histories survive eviction', async () => {
		const { log, world, deliver, callbacks } = await setup();
		const alice = world.entity(ALICE, aliceResponder);
		const bob = world.entity(BOB, bobResponder);
		await alice.open();

		// The entity tools are offered like any other tool.
		const root = await alice.requireHost().harness.conversation(ROOT_CONVERSATION_ID, context);
		expect(await root?.getActiveTools(context)).toEqual(
			expect.arrayContaining([...ENTITY_TOOL_NAMES]),
		);

		// 1. Alice's send_message appends one event straight to Bob's inbox; Bob has never been opened.
		await alice.requireHost().admit(
			{
				submissionId: 'sub_ask',
				kind: 'dispatch',
				message: { kind: 'user', body: 'please ask bob how he is' },
				acceptedAt: new Date(world.clock.now).toISOString(),
				whenBusy: 'followUp',
			},
			context,
		);
		expect((await alice.requireHost().waitForSettlement('sub_ask', context)).outcome).toBe(
			'completed',
		);
		expect(bob.isOpen).toBe(false);
		const bobInbox = await readAll(log, inboxPath(BOB));
		expect(bobInbox).toEqual([
			{
				type: 'flue.a2a.message',
				from: ALICE,
				messageId: expect.stringMatching(/^agent\/alice\/\d+\/.+$/),
				message: { text: 'ping' },
			},
		]);
		const ping = bobInbox[0] as { messageId: string };

		// 2. The signed webhook rings Bob's doorbell. Nothing is processed and Bob stays asleep;
		//    the wake is acked through its callback once the head is recorded.
		const bobTail = await tail(log, inboxPath(BOB));
		expect(await deliver(inboxWake(1, BOB, bobTail))).toEqual({
			status: 200,
			json: { ok: true, entities: ['agent/bob'], acked: 'callback' },
		});
		expect(bob.isOpen).toBe(false);
		expect(bob.alarmArmed).toBe(true);
		expect(callbacks.at(-1)?.body).toMatchObject({
			acks: [{ stream: wirePath(inboxPath(BOB)), offset: bobTail }],
			done: true,
		});

		// 3. The alarm pumps: Bob is reconstructed, admits the event under its id, and replies.
		await world.runAlarms();
		const bobSubmission = await deriveKeyedSubmissionId(BOB.type, BOB.id, ping.messageId);
		expect((await bob.requireHost().waitForSettlement(bobSubmission, context)).outcome).toBe(
			'completed',
		);
		const aliceInbox = await readAll(log, inboxPath(ALICE));
		expect(aliceInbox).toEqual([
			expect.objectContaining({ type: 'flue.a2a.message', from: BOB, message: { text: 'pong' } }),
		]);
		const pong = aliceInbox[0] as { messageId: string };

		// 4. Alice is rung and pumped the same way.
		await deliver(inboxWake(2, ALICE, await tail(log, inboxPath(ALICE))));
		await world.runAlarms();
		const aliceSubmission = await deriveKeyedSubmissionId(ALICE.type, ALICE.id, pong.messageId);
		expect((await alice.requireHost().waitForSettlement(aliceSubmission, context)).outcome).toBe(
			'completed',
		);

		const histories = { alice: await transcript(alice), bob: await transcript(bob) };
		expect(histories.alice.map((entry) => entry.text)).toEqual(
			expect.arrayContaining(['Asked Bob.', 'Bob answered pong.']),
		);
		expect(histories.bob.map((entry) => entry.text)).toEqual(
			expect.arrayContaining(['Replied to Alice.']),
		);
		const calls = { alice: alice.calls, bob: bob.calls };

		// 5. Eviction, then a redeploy: fresh hosts over the same SQLite files.
		await world.closeAll();
		await alice.open();
		await bob.open();
		for (const [name, entity] of [
			['alice', alice],
			['bob', bob],
		] as const) {
			const after = await transcript(entity);
			expect(after.slice(0, histories[name].length)).toEqual(histories[name]);
		}
		// Nothing re-ran, and nothing was delivered twice.
		expect({ alice: alice.calls, bob: bob.calls }).toEqual(calls);
		expect(await readAll(log, inboxPath(BOB))).toHaveLength(1);
		expect(await readAll(log, inboxPath(ALICE))).toHaveLength(1);
		// Pi's commits never left the entities: the only streams are the two inboxes.
		expect(await log.head(`flue/v1/agent/alice/pi`)).toBeNull();
	});
});

// ─── Doorbells and the pump ─────────────────────────────────────────────────

describe('doorbells and the alarm pump', () => {
	async function messageBob(h: Harness, messageId: string, text = 'hello') {
		const runtime = await h.world.entity(ALICE).open();
		return runtime.messaging.send(BOB, { text }, { messageId }, context);
	}

	async function bobSubmissions(bob: TestEntity): Promise<number> {
		return (await bob.requireStorage().scanSubmissions({}, 1000, undefined, context)).items.length;
	}

	it('the doorbell is durable: a crash after the high-water write, before the alarm, still processes the events', async () => {
		const h = await setup();
		const receipt = await messageBob(h, 'm-crash');
		const bob = h.world.entity(BOB);
		await bob.open();
		await h.deliver(inboxWake(1, BOB, await tail(h.log, inboxPath(BOB))));
		// The isolate dies before the alarm handler runs: nothing in memory survives.
		bob.kill();
		expect(bob.isOpen).toBe(false);
		// The alarm is durable; it fires against a new incarnation that pumps from the book.
		expect(bob.alarmArmed).toBe(true);
		await h.world.runAlarms();
		expect(bob.incarnations).toHaveLength(2);
		expect((await bob.requireHost().waitForSettlement(receipt.submissionId, context)).outcome).toBe(
			'completed',
		);
	});

	it('duplicate and stale webhooks are idempotent', async () => {
		const h = await setup();
		const receipt = await messageBob(h, 'm-dup');
		const bob = h.world.entity(BOB);
		const head = await tail(h.log, inboxPath(BOB));
		expect((await h.deliver(inboxWake(5, BOB, head))).json).toMatchObject({ acked: 'callback' });
		await h.world.runAlarms();
		expect((await bob.requireHost().waitForSettlement(receipt.submissionId, context)).outcome).toBe(
			'completed',
		);
		await bob.requireHost().harness.waitForIdle(context);
		const submissions = await bobSubmissions(bob);
		const calls = bob.calls;

		// The same wake again, and a stale one with an older generation and head:
		// each is rung and acked; the pump finds the cursor already at the head.
		expect((await h.deliver(inboxWake(5, BOB, head))).json).toMatchObject({ acked: 'callback' });
		expect(
			(await h.deliver(inboxWake(4, BOB, '0000000000000000_0000000000000001'))).json,
		).toMatchObject({ acked: 'callback' });
		await h.world.runAlarms();
		expect(bob.pumps.at(-1)).toMatchObject({ events: 0, reads: 0, behind: false });
		// And after the cursor was lost entirely: admission deduplicates by event id.
		const book = await bob.book();
		bob.database?.inner.exec("UPDATE flue_entity_streams SET cursor = '-1'");
		expect(book.behind()).toBe(true);
		bob.alarmArmed = true;
		await h.world.runAlarms();
		await bob.requireHost().harness.waitForIdle(context);
		expect(await bobSubmissions(bob)).toBe(submissions);
		expect(bob.calls).toBe(calls);
	});

	it('the bounded pump re-arms while it is behind', async () => {
		const h = await setup(new InMemoryDurableStreamLog({ maxReadMessages: 2 }));
		h.world.pumpLimits = { reads: 1, events: 2, wallMs: 60_000 };
		const alice = h.world.entity(ALICE);
		const runtime = await alice.open();
		const sent = [];
		for (let n = 0; n < 5; n++)
			sent.push(
				await runtime.messaging.send(BOB, { text: `m${n}` }, { messageId: `m${n}` }, context),
			);
		const bob = h.world.entity(BOB);
		await h.deliver(inboxWake(1, BOB, await tail(h.log, inboxPath(BOB))));
		const first = await bob.alarm();
		expect(first).toMatchObject({ behind: true, reads: 1 });
		expect(bob.alarmArmed).toBe(true);
		await h.world.runAlarms();
		expect(bob.pumps.length).toBeGreaterThanOrEqual(3);
		expect(bob.pumps.at(-1)?.behind).toBe(false);
		for (const receipt of sent) {
			expect(
				(await bob.requireHost().waitForSettlement(receipt.submissionId, context)).outcome,
			).toBe('completed');
		}
	});

	it('a crash during a send, then the replay: exactly one admission at the receiver', async () => {
		const h = await setup();
		const alice = h.world.entity(ALICE, aliceResponder);
		const bob = h.world.entity(BOB, bobResponder);
		await alice.open();
		// Alice dies right after her send_message POST landed, before its result committed.
		alice.arm({ kind: 'crash-after-send', after: 0 });
		const first = alice.incarnation;
		await alice.requireHost().admit(
			{
				submissionId: 'sub_ask',
				kind: 'dispatch',
				message: { kind: 'user', body: 'please ask bob' },
				acceptedAt: new Date(h.world.clock.now).toISOString(),
				whenBusy: 'followUp',
			},
			context,
		);
		await new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = () => {
				if (first?.dead) resolve();
				else if (Date.now() - started > 10_000) reject(new Error('the fault never fired'));
				else setTimeout(poll, 10);
			};
			poll();
		});
		// Reopen: Pi Durable replays the replay-safe tool call, which sends the same event again.
		await alice.open();
		await alice.requireHost().wake({ kind: 'live-tasks' }, context);
		expect((await alice.requireHost().waitForSettlement('sub_ask', context)).outcome).toBe(
			'completed',
		);
		const inbox = (await readAll(h.log, inboxPath(BOB))) as { messageId: string }[];
		expect(inbox).toHaveLength(2);
		expect(inbox[1]?.messageId).toBe(inbox[0]?.messageId);

		await h.deliver(inboxWake(1, BOB, await tail(h.log, inboxPath(BOB))));
		await h.world.runAlarms();
		const submissionId = await deriveKeyedSubmissionId(BOB.type, BOB.id, inbox[0]?.messageId ?? '');
		expect((await bob.requireHost().waitForSettlement(submissionId, context)).outcome).toBe(
			'completed',
		);
		await bob.requireHost().harness.waitForIdle(context);
		const inputs = (
			await bob.requireStorage().scanSubmissions({}, 1000, undefined, context)
		).items.filter((submission) => submission.type === 'input');
		expect(inputs.map((submission) => submission.requestId)).toEqual([submissionId]);
		expect(bob.calls).toBe(2);
	});
});

// ─── The wake route ─────────────────────────────────────────────────────────

describe('webhook wakes', () => {
	it('rejects unsigned, forged and expired wakes', async () => {
		const h = await setup();
		const body = inboxWake(1, BOB, '0000000000000000_0000000000000010');
		const route = createEntityWakeRoute({
			keys: staticWebhookKeys({ keys: [h.signer.jwk] }),
			wake: h.world.wake,
			now: () => h.world.clock.now,
		});
		const unsigned = await route.fetch(new Request(WAKE_URL, { method: 'POST', body }));
		expect(unsigned.status).toBe(401);
		const signed = await h.signer.request(WAKE_URL, body, h.world.clock.now);
		const forged = await route.fetch(
			new Request(WAKE_URL, { method: 'POST', headers: signed.headers, body: `${body} ` }),
		);
		expect(forged.status).toBe(401);
		const expired = await route.fetch(
			await h.signer.request(WAKE_URL, body, h.world.clock.now - 3_600_000),
		);
		expect(expired.status).toBe(401);
		expect(h.world.woken).toEqual([]);
	});

	it('acks an agents-server wake through its callback, never with {done:true}', async () => {
		const h = await setup();
		await h.world.entity(ALICE).open();
		await (
			await h.world.entity(ALICE).open()
		).messaging.send(BOB, { text: 'hi' }, { messageId: 'm-proxied' }, context);
		const offset = await tail(h.log, inboxPath(BOB));
		const proxied = await h.deliver(
			agentsServerWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 11,
				streams: [
					{ path: inboxPath(BOB), tailOffset: offset },
					{ path: inboxPath(ALICE), tailOffset: '0000000000000000_0000000000000099' },
				],
			}),
		);
		expect(proxied).toEqual({
			status: 200,
			json: { ok: true, entities: ['agent/bob'], acked: 'callback' },
		});
		expect(h.callbacks).toEqual([
			{
				url: 'https://agents.test/_electric/wake-callbacks/w_11',
				headers: { authorization: 'Bearer token-123', 'content-type': 'application/json' },
				body: {
					generation: 11,
					acks: [{ stream: wirePath(inboxPath(BOB)), offset }],
					done: true,
					wake_id: 'w_11',
				},
			},
		]);
		expect(h.world.woken).toEqual([
			{ entity: 'agent/bob', doorbell: { stream: inboxPath(BOB), head: offset } },
		]);

		// A FENCED callback (a newer wake took over) is fine: the head is recorded.
		h.callbackResponse = () =>
			Response.json({ error: { code: 'FENCED', message: 'stale' } }, { status: 409 });
		const fenced = await h.deliver(
			agentsServerWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 12,
				streams: [{ path: inboxPath(BOB), tailOffset: offset }],
			}),
		);
		expect(fenced.json).toMatchObject({ acked: 'fenced' });
	});

	it('answers 503 and acks nothing when a doorbell fails', async () => {
		const h = await setup();
		const route = createEntityWakeRoute({
			keys: staticWebhookKeys({ keys: [h.signer.jwk] }),
			wake: async () => {
				throw new Error('DO unavailable');
			},
			fetch: async (url, init) => {
				h.callbacks.push({ url, headers: {}, body: init?.body });
				return Response.json({ ok: true });
			},
			now: () => h.world.clock.now,
		});
		const response = await route.fetch(
			await h.signer.request(
				WAKE_URL,
				inboxWake(1, BOB, '0000000000000000_0000000000000010'),
				h.world.clock.now,
			),
		);
		expect(response.status).toBe(503);
		expect(h.callbacks).toEqual([]);
	});
});

// ─── Spawn, schedule, observe ───────────────────────────────────────────────

describe('entity lifecycle', () => {
	it('spawn is idempotent per key and births the child with a known uid and initial data', async () => {
		const h = await setup();
		const alice = h.world.entity(ALICE);
		const runtime = await alice.open();
		const child: EntityRef = { type: 'worker', id: 'alice/w1' };
		const uid = await spawnedUid(child);
		const first = await runtime.lifecycle.spawn(
			'worker',
			{ key: 'w1', initialData: { n: 1 } },
			context,
		);
		expect(first).toEqual({ ...child, uid });
		// A repeat appends the same event again; the child admits it once.
		expect(
			await runtime.lifecycle.spawn('worker', { key: 'w1', initialData: { n: 1 } }, context),
		).toEqual(first);
		const inbox = await readAll(h.log, inboxPath(child));
		expect(inbox).toHaveLength(2);
		expect(inbox[0]).toEqual(
			expect.objectContaining({
				from: ALICE,
				directive: { kind: 'spawn', uid, initialData: { n: 1 } },
			}),
		);
		expect(inbox[1]).toEqual(inbox[0]);
		// The child's streams exist before anything was sent to them.
		expect(
			await h.log.head(`flue/v1/worker/${encodeURIComponent('alice/w1')}/events`),
		).not.toBeNull();

		const woken = await h.deliver(inboxWake(1, child, await tail(h.log, inboxPath(child))));
		expect(woken.json).toMatchObject({ entities: [entityKey(child)] });
		await h.world.runAlarms();
		const worker = h.world.entity(child);
		const submissionId = await deriveKeyedSubmissionId(
			child.type,
			child.id,
			(inbox[0] as { messageId: string }).messageId,
		);
		expect((await worker.requireHost().waitForSettlement(submissionId, context)).outcome).toBe(
			'completed',
		);
		const instance = await worker.requireHost().harness.snapshot(FlueInstance, context);
		expect(instance).toMatchObject({ uid, initialData: { value: { n: 1 } } });
		await worker.requireHost().harness.waitForIdle(context);
		expect(worker.calls).toBe(1);
	});

	it('a self-schedule fires once, across a reopen', async () => {
		const h = await setup();
		const alice = h.world.entity(ALICE);
		const runtime = await alice.open();
		const at = h.world.clock.now + 60_000;
		await runtime.lifecycle.schedule(
			ALICE,
			at,
			{ text: 'remind me' },
			{ scheduleId: 'r1' },
			context,
		);
		expect(alice.wakes).toContainEqual({
			atMs: at,
			reason: { kind: 'schedule', scheduleId: 'r1' },
		});
		await runtime.wake({ kind: 'schedule', scheduleId: 'r1' }, context);
		expect(
			await alice.requireHost().settlement(scheduleSubmissionId('r1'), context),
		).toBeUndefined();

		await alice.close();
		h.world.clock.now = at + 1;
		const reopened = await alice.open();
		await reopened.wake({ kind: 'schedule', scheduleId: 'r1' }, context);
		expect(
			(await alice.requireHost().waitForSettlement(scheduleSubmissionId('r1'), context)).outcome,
		).toBe('completed');
		const calls = alice.calls;
		await reopened.wake({ kind: 'schedule', scheduleId: 'r1' }, context);
		await alice.close();
		await (await alice.open()).wake({ kind: 'schedule', scheduleId: 'r1' }, context);
		await alice.requireHost().harness.waitForIdle(context);
		expect(alice.calls).toBe(calls);
	});

	it('schedules another entity through its inbox; the target arms and fires its own copy', async () => {
		const h = await setup();
		const alice = h.world.entity(ALICE);
		const runtime = await alice.open();
		const at = h.world.clock.now + 5_000;
		await runtime.lifecycle.schedule(BOB, at, { text: 'standup' }, { scheduleId: 's1' }, context);
		await h.deliver(inboxWake(1, BOB, await tail(h.log, inboxPath(BOB))));
		await h.world.runAlarms();
		const bob = h.world.entity(BOB);
		const key = relayedScheduleKey(ALICE, 's1');
		expect(bob.wakes).toContainEqual({ atMs: at, reason: { kind: 'schedule', scheduleId: key } });
		expect(bob.calls).toBe(0);
		await bob.close();
		h.world.clock.now = at;
		await (await bob.open()).wake({ kind: 'schedule', scheduleId: key }, context);
		expect(
			(await bob.requireHost().waitForSettlement(scheduleSubmissionId(key), context)).outcome,
		).toBe('completed');
	});

	it('observes an external world stream; its wakes reach only the subscribed entity', async () => {
		const h = await setup();
		const observedCalls: { entity: string; streams: readonly string[] }[] = [];
		h.world.subscriptions = {
			observe: async (entity, streams) => {
				observedCalls.push({ entity: entityKey(entity), streams });
			},
			unobserve: async () => {},
		};
		const world = 'world/hn/items';
		await h.log.ensure(world);
		const item = (n: number) => ({
			type: 'society.observation',
			v: 1,
			source: 'rsshub',
			id: `hn-${n}`,
			title: `Story ${n}`,
		});
		await h.log.append(world, [item(1)]);
		await h.log.append(world, [item(2)]);

		const alice = h.world.entity(ALICE);
		const bob = h.world.entity(BOB);
		const runtime = await alice.open();
		await bob.open();
		expect(
			await runtime.observation.observe({ stream: world }, { key: 'hn', wake: true }, context),
		).toEqual({ key: 'hn', offset: '-1' });
		expect(observedCalls).toEqual([{ entity: 'agent/alice', streams: [world] }]);

		const wake = (generation: number, tailOffset: string) =>
			h.deliver(
				durableStreamsWakeBody({
					subscriptionId: observeSubscriptionId(ALICE),
					generation,
					streams: [{ path: world, tailOffset }],
				}),
			);
		expect((await wake(1, await tail(h.log, world))).json).toMatchObject({
			entities: ['agent/alice'],
		});
		await h.world.runAlarms();
		const observed = async (entity: TestEntity) =>
			(await entity.entries())
				.filter((entry) => entry.kind === 'flue.observed')
				.map((entry) => entry.data);
		await alice.requireHost().harness.waitForIdle(context);
		expect(await observed(alice)).toEqual([
			expect.objectContaining({ key: 'hn', stream: world, index: 0, item: item(1) }),
			expect.objectContaining({ key: 'hn', stream: world, index: 1, item: item(2) }),
		]);
		expect(await observed(bob)).toEqual([]);
		expect(runtime.observation.cursors.value?.hn?.offset).toBe(await tail(h.log, world));

		// A duplicate wake records nothing new; a new item is recorded once.
		await wake(1, await tail(h.log, world));
		await h.log.append(world, [item(3)]);
		await wake(2, await tail(h.log, world));
		await h.world.runAlarms();
		await alice.requireHost().harness.waitForIdle(context);
		expect(
			(await observed(alice)).map((data) => (data as { item: { id: string } }).item.id),
		).toEqual(['hn-1', 'hn-2', 'hn-3']);

		// The same stream on the inbox subscription is nobody's inbox: it rings no one.
		const before = h.world.woken.length;
		const unowned = await h.deliver(
			durableStreamsWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 9,
				streams: [{ path: world, tailOffset: await tail(h.log, world) }],
			}),
		);
		expect(unowned.json).toMatchObject({ entities: [] });
		expect(h.world.woken.length).toBe(before);
	});

	it('a published event an observer reads twice (a replayed publish) is recorded once', async () => {
		const h = await setup();
		const alice = h.world.entity(ALICE);
		const bob = h.world.entity(BOB);
		const aliceRuntime = await alice.open();
		const bobRuntime = await bob.open();
		await bobRuntime.observation.observe(
			{ entity: ALICE, channel: 'events' },
			{ key: 'alice', wake: false },
			context,
		);
		await aliceRuntime.messaging.publish({ n: 1 }, { eventId: 'e1' }, context);
		await aliceRuntime.messaging.publish({ n: 1 }, { eventId: 'e1' }, context);
		await bobRuntime.observation.poll('alice', {}, context);
		await bob.requireHost().harness.waitForIdle(context);
		const observed = (await bob.entries()).filter((entry) => entry.kind === 'flue.observed');
		expect(observed).toHaveLength(1);
	});
});
