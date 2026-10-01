/**
 * The A2A entity layer end to end, in process: InMemoryDurableStreamLog +
 * node:sqlite StreamStorage + real FluePiHosts on pi-ai's faux provider, with
 * wakes delivered as Ed25519-signed webhooks through the Worker route.
 *
 * The first test is the #3752 acceptance scenario.
 */
import type { Message } from '@earendil-works/pi-ai';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { afterEach, describe, expect, it } from 'vitest';
import { FlueInstance } from '../pi/docs.ts';
import { A2A_SEND_ENTRY_KIND } from '../pi/a2a-entries.ts';
import {
	CrashError,
	openStreamStorage,
	removeTempFiles,
	snapshotReads,
	tempFile,
} from '../pi/stream-storage-test-support.ts';
import type { StreamStorage } from '../pi/stream-storage.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import type { AppendOutcome, DurableStreamLog, ProducerClaim, ReadBatch } from '../streams/log.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import type { StreamOffset } from '../streams/offset.ts';
import {
	agentsServerWakeBody,
	answer,
	context,
	durableStreamsWakeBody,
	eventually,
	lastMessage,
	readAll,
	type TestEntity,
	TestWorld,
	textOf,
	toolCall,
	WebhookSigner,
} from './a2a-test-support.ts';
import { spawnedUid } from './facet.ts';
import { relayedScheduleKey } from './inbox.ts';
import { entityKey, inboxPath, INBOX_SUBSCRIPTION_ID, observeSubscriptionId, wirePath } from './paths.ts';
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
	if (textOf(last).includes('ping')) return toolCall('send_message', { target: ALICE, text: 'pong' });
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

async function setup(log: InMemoryDurableStreamLog = new InMemoryDurableStreamLog()): Promise<Harness> {
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

afterEach(async () => {
	for (const world of worlds) await world.closeAll().catch(() => {});
	worlds.length = 0;
	await removeTempFiles();
});

describe('A2A entities (#3752 acceptance)', () => {
	it('Alice messages sleeping Bob; Bob wakes, replies; both histories survive eviction and redeploy', async () => {
		const { log, world, deliver } = await setup();
		const alice = world.entity(ALICE, aliceResponder);
		const bob = world.entity(BOB, bobResponder);
		await alice.open();

		// The entity tools are offered like any other tool.
		const root = await alice.requireHost().harness.conversation(ROOT_CONVERSATION_ID, context);
		expect(await root?.getActiveTools(context)).toEqual(expect.arrayContaining([...ENTITY_TOOL_NAMES]));

		// 1. Alice sends Bob a durable message; Bob has never been opened.
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
		expect((await alice.requireHost().waitForSettlement('sub_ask', context)).outcome).toBe('completed');
		await alice.flush();
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

		// 2. The wake: a signed webhook on the inbox subscription.
		const wakeBob = await deliver(
			durableStreamsWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 1,
				streams: [{ path: inboxPath(BOB), tailOffset: await tail(log, inboxPath(BOB)) }],
			}),
		);
		expect(wakeBob).toEqual({ status: 200, json: { done: true, entities: ['agent/bob'], acked: 'done-reply' } });

		// 3. Bob reconstructed, ran Pi on the message, and replied with send_message.
		expect(bob.isOpen).toBe(true);
		const bobSubmission = await deriveKeyedSubmissionId(BOB.type, BOB.id, ping.messageId);
		expect((await bob.requireHost().waitForSettlement(bobSubmission, context)).outcome).toBe('completed');
		await bob.flush();
		const aliceInbox = await readAll(log, inboxPath(ALICE));
		expect(aliceInbox).toEqual([
			expect.objectContaining({ type: 'flue.a2a.message', from: BOB, message: { text: 'pong' } }),
		]);
		const pong = aliceInbox[0] as { messageId: string };

		// 4. Alice is woken and receives it.
		const wakeAlice = await deliver(
			durableStreamsWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 2,
				streams: [
					{ path: inboxPath(ALICE), tailOffset: await tail(log, inboxPath(ALICE)) },
					{ path: inboxPath(BOB), tailOffset: await tail(log, inboxPath(BOB)), pending: false },
				],
			}),
		);
		expect(wakeAlice.json).toMatchObject({ done: true, entities: ['agent/alice'] });
		const aliceSubmission = await deriveKeyedSubmissionId(ALICE.type, ALICE.id, pong.messageId);
		expect((await alice.requireHost().waitForSettlement(aliceSubmission, context)).outcome).toBe('completed');
		await alice.flush();
		await bob.flush();

		const histories = { alice: await transcript(alice), bob: await transcript(bob) };
		expect(histories.alice.map((entry) => entry.text)).toEqual(
			expect.arrayContaining(['Asked Bob.', 'Bob answered pong.']),
		);
		expect(histories.alice.some((entry) => entry.kind === A2A_SEND_ENTRY_KIND)).toBe(true);
		expect(histories.bob.some((entry) => entry.kind === A2A_SEND_ENTRY_KIND)).toBe(true);
		expect(histories.bob.map((entry) => entry.text)).toEqual(expect.arrayContaining(['Replied to Alice.']));
		const calls = { alice: alice.calls, bob: bob.calls };

		// 5. Eviction: everything in memory goes; the sqlite files and the log stay.
		await world.closeAll();
		// Redeploy: fresh hosts reconstruct from their databases.
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

		// 6. Both histories replay from the log alone, identically.
		for (const entity of [alice, bob]) {
			await entity.flush();
			const seq = entity.lastSeq();
			const reads = await snapshotReads(entity.requireStorage(), seq);
			const rebuilt = await openStreamStorage({ file: await tempFile(), log, entity: entity.ref });
			try {
				expect(rebuilt.fences).toEqual([]);
				expect(await snapshotReads(rebuilt.storage, seq)).toEqual(reads);
			} finally {
				await rebuilt.storage.close(context);
			}
		}
		expect(alice.fences).toEqual([]);
		expect(bob.fences).toEqual([]);
	});
});

// ─── Relay: exactly once ────────────────────────────────────────────────────

/** A log that fails appends to chosen paths. */
class RoutedFaultLog implements DurableStreamLog {
	readonly inner: DurableStreamLog;
	readonly appends: { path: string; producer: ProducerClaim; outcome: string }[] = [];
	readonly blocked = new Set<string>();
	#crash: { path: string; point: 'before-append' | 'drop-ack' } | undefined;

	constructor(inner: DurableStreamLog) {
		this.inner = inner;
	}

	crashOnce(path: string, point: 'before-append' | 'drop-ack'): void {
		this.#crash = { path, point };
	}

	ensure(path: string, signal?: AbortSignal) {
		return this.inner.ensure(path, signal);
	}

	async append(
		path: string,
		input: { readonly messages: readonly unknown[]; readonly producer: ProducerClaim; readonly streamSeq?: string },
		signal?: AbortSignal,
	): Promise<AppendOutcome> {
		if (this.blocked.has(path)) {
			this.appends.push({ path, producer: input.producer, outcome: 'blocked' });
			return { status: 'retryable', error: new Error('blocked') };
		}
		const crash = this.#crash?.path === path ? this.#crash : undefined;
		if (crash) this.#crash = undefined;
		if (crash?.point === 'before-append') throw new CrashError('crash before the POST');
		const outcome = await this.inner.append(path, input, signal);
		this.appends.push({ path, producer: input.producer, outcome: outcome.status });
		if (crash?.point === 'drop-ack') throw new CrashError('crash after the append, before the ack');
		return outcome;
	}

	read(
		path: string,
		from: StreamOffset,
		options?: { readonly live?: false | 'long-poll' | 'sse'; readonly cursor?: string; readonly signal?: AbortSignal },
	): Promise<ReadBatch> {
		return this.inner.read(path, from, options);
	}

	head(path: string, signal?: AbortSignal) {
		return this.inner.head(path, signal);
	}
}

let entryId = 1000;

async function openAlice(file: string, log: DurableStreamLog) {
	// `await`: a commit returns once its envelope is published and its relay rows were tried,
	// so each injected fault is consumed by the commit that caused it.
	return openStreamStorage({ file, log, entity: ALICE, relay: true, publish: 'await', publishTimeoutMs: 100 });
}

async function commitSend(storage: StreamStorage, messageId: string, target: EntityRef = BOB): Promise<number> {
	return storage.commit(
		[
			{
				type: 'entry',
				value: {
					id: entryId++,
					conversationId: 1,
					kind: A2A_SEND_ENTRY_KIND,
					data: { target, messageId, message: { text: messageId } },
				},
			},
		] as never,
		context,
	);
}

async function inboxIds(log: DurableStreamLog, entity: EntityRef = BOB): Promise<string[]> {
	return (await readAll(log, inboxPath(entity))).map((message) => (message as { messageId: string }).messageId);
}

describe('relay drainer', () => {
	const opened: StreamStorage[] = [];
	afterEach(async () => {
		for (const storage of opened) await storage.close(context).catch(() => {});
		opened.length = 0;
	});

	async function open(file: string, log: DurableStreamLog) {
		const result = await openAlice(file, log);
		opened.push(result.storage);
		return result;
	}

	it('crash before the POST: the row survives and reopening delivers it once', async () => {
		const log = new InMemoryDurableStreamLog();
		const faulty = new RoutedFaultLog(log);
		const file = await tempFile();
		const first = await open(file, faulty);
		await first.storage.commit([{ type: 'conversation', value: { id: 1 } }] as never, context);
		faulty.crashOnce(inboxPath(BOB), 'before-append');
		await commitSend(first.storage, 'm-1');
		expect(first.storage.relay.pending()).toBe(1);
		expect(await inboxIds(log)).toEqual([]);
		await first.storage.close(context);

		const second = await open(file, log);
		await second.storage.drain();
		expect(second.storage.relay.pending()).toBe(0);
		expect(await inboxIds(log)).toEqual(['m-1']);
	});

	it('crash after the append, before the ack: the retry is an in-epoch duplicate', async () => {
		const log = new InMemoryDurableStreamLog();
		const faulty = new RoutedFaultLog(log);
		const file = await tempFile();
		const first = await open(file, faulty);
		await first.storage.commit([{ type: 'conversation', value: { id: 1 } }] as never, context);
		// The inbox exists, so the crashing POST is the one that lands.
		await log.ensure(inboxPath(BOB));
		faulty.crashOnce(inboxPath(BOB), 'drop-ack');
		await commitSend(first.storage, 'm-1');
		expect(first.storage.relay.pending()).toBe(1);
		expect(await inboxIds(log)).toEqual(['m-1']);
		await first.storage.close(context);

		const recording = new RoutedFaultLog(log);
		const second = await open(file, recording);
		await second.storage.drain();
		expect(second.storage.relay.pending()).toBe(0);
		expect(recording.appends.filter((append) => append.path === inboxPath(BOB))).toEqual([
			{ path: inboxPath(BOB), producer: { id: 'agent/alice->inbox', epoch: 0, seq: 0 }, outcome: 'duplicate' },
		]);
		expect(second.storage.relay.pending()).toBe(0);
		await commitSend(second.storage, 'm-2');
		await second.storage.drain();
		expect(await inboxIds(log)).toEqual(['m-1', 'm-2']);
	});

	it('never posts a relay row before its Pi commit is on the log', async () => {
		const log = new InMemoryDurableStreamLog();
		const faulty = new RoutedFaultLog(log);
		const first = await open(await tempFile(), faulty);
		await first.storage.commit([{ type: 'conversation', value: { id: 1 } }] as never, context);
		faulty.blocked.add(first.storage.path);
		await commitSend(first.storage, 'm-1');
		expect(await first.storage.drainRelay()).toEqual({ status: 'gated' });
		expect(await inboxIds(log)).toEqual([]);
		faulty.blocked.clear();
		await first.storage.drain();
		expect(await inboxIds(log)).toEqual(['m-1']);
	});

	/**
	 * The relay-epoch gap: an epoch bump that publishes no Pi envelope but
	 * delivers relay messages, then a fresh rebuild that reuses that epoch.
	 */
	async function epochGapScenario(options: { readonly ungatedPost: boolean }) {
		const log = new InMemoryDurableStreamLog();
		const faulty = new RoutedFaultLog(log);
		const first = await open(await tempFile(), faulty);
		await first.storage.commit([{ type: 'conversation', value: { id: 1 } }] as never, context);
		await commitSend(first.storage, 'm-1');
		expect(await inboxIds(log)).toEqual(['m-1']);

		// An epoch bump (here an in-place rebuild) …
		await first.storage.rebuild(context);
		expect(first.storage.outbox.requireProducer().epoch).toBe(1);
		// … whose Pi envelopes never reach the log.
		faulty.blocked.add(first.storage.path);
		await commitSend(first.storage, 'm-2');
		expect(await first.storage.drainRelay()).toEqual({ status: 'gated' });
		const [row] = first.storage.relay.pendingRows();
		expect(row).toMatchObject({ producerEpoch: 1, producerSeq: 0 });
		if (options.ungatedPost && row) {
			// What a drainer without the gate would do: deliver m-2 under epoch 1.
			const outcome = await log.append(row.target, {
				messages: [JSON.parse(row.body)],
				producer: { id: row.producerId, epoch: row.producerEpoch, seq: row.producerSeq },
			});
			expect(outcome.status).toBe('appended');
		}
		// The DO is lost with its database: m-2 was never on Alice's log.
		await first.storage.close(context);

		const recording = new RoutedFaultLog(log);
		const fresh = await open(await tempFile(), recording);
		// Rebuilt from the log alone: the log's highest epoch is 0, so it reuses epoch 1.
		expect(fresh.storage.outbox.requireProducer().epoch).toBe(1);
		await commitSend(fresh.storage, 'm-3');
		expect(fresh.storage.relay.pending()).toBe(0);
		const [posted, ...more] = recording.appends.filter((append) => append.path === inboxPath(BOB));
		expect(more).toEqual([]);
		expect(posted?.producer).toEqual({ id: 'agent/alice->inbox', epoch: 1, seq: 0 });
		return { inbox: await inboxIds(log), outcome: posted?.outcome };
	}

	it('relay-epoch gap: without the publish gate, a fresh rebuild loses the next message as a duplicate', async () => {
		// m-2 reached Bob although Alice's history never held it, and m-3 —
		// sent under the same (epoch 1, seq 0) claim — is dropped as a duplicate.
		expect(await epochGapScenario({ ungatedPost: true })).toEqual({ inbox: ['m-1', 'm-2'], outcome: 'duplicate' });
	});

	it('relay-epoch gap: the publish gate keeps every relay epoch on the log, so the rebuild loses nothing', async () => {
		expect(await epochGapScenario({ ungatedPost: false })).toEqual({ inbox: ['m-1', 'm-3'], outcome: 'appended' });
	});
});

// ─── Wakes ──────────────────────────────────────────────────────────────────

describe('webhook wakes', () => {
	async function messageBob(h: Harness, messageId: string, text = 'hello') {
		const alice = h.world.entity(ALICE);
		const runtime = await alice.open();
		const receipt = await runtime.messaging.send(BOB, { text }, { messageId }, context);
		await alice.flush();
		return receipt;
	}

	async function bobSubmissions(bob: TestEntity): Promise<number> {
		return (await bob.requireStorage().scanSubmissions({}, 1000, undefined, context)).items.length;
	}

	it('rejects unsigned, forged and expired wakes', async () => {
		const h = await setup();
		const body = durableStreamsWakeBody({
			subscriptionId: INBOX_SUBSCRIPTION_ID,
			generation: 1,
			streams: [{ path: inboxPath(BOB), tailOffset: '0000000000000000_0000000000000010' }],
		});
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
		const expired = await route.fetch(await h.signer.request(WAKE_URL, body, h.world.clock.now - 3_600_000));
		expect(expired.status).toBe(401);
		expect(h.world.woken).toEqual([]);
	});

	it('duplicate deliveries admit nothing twice, even with a lost cursor', async () => {
		const h = await setup();
		const receipt = await messageBob(h, 'm-dup');
		const bob = h.world.entity(BOB);
		const body = durableStreamsWakeBody({
			subscriptionId: INBOX_SUBSCRIPTION_ID,
			generation: 5,
			streams: [{ path: inboxPath(BOB), tailOffset: await tail(h.log, inboxPath(BOB)) }],
		});
		expect((await h.deliver(body)).json).toMatchObject({ done: true });
		expect((await bob.requireHost().waitForSettlement(receipt.submissionId, context)).outcome).toBe('completed');
		const submissions = await bobSubmissions(bob);
		const calls = bob.calls;

		// The same wake again: the cursor is past it.
		expect((await h.deliver(body)).json).toMatchObject({ done: true });
		// And again after the cursor was lost: admission deduplicates by request id.
		const runtime = await bob.open();
		await bob.requireStorage().cursors.delete(runtime.inbox.cursorKey);
		expect((await h.deliver(body)).json).toMatchObject({ done: true });
		await bob.requireHost().harness.waitForIdle(context);
		expect(await bobSubmissions(bob)).toBe(submissions);
		expect(bob.calls).toBe(calls);
		expect(h.world.woken.map((wake) => wake.entity)).toEqual(['agent/bob', 'agent/bob', 'agent/bob']);
	});

	it('a stale generation is processed idempotently but never acked', async () => {
		const h = await setup();
		await messageBob(h, 'm-1');
		const streams = [{ path: inboxPath(BOB), tailOffset: await tail(h.log, inboxPath(BOB)) }];
		expect(
			(await h.deliver(durableStreamsWakeBody({ subscriptionId: INBOX_SUBSCRIPTION_ID, generation: 7, streams })))
				.json,
		).toMatchObject({ done: true });
		const stale = await h.deliver(
			durableStreamsWakeBody({ subscriptionId: INBOX_SUBSCRIPTION_ID, generation: 6, streams }),
		);
		expect(stale).toEqual({ status: 200, json: { ok: true, entities: ['agent/bob'], acked: 'stale' } });
		const staleProxied = await h.deliver(
			agentsServerWakeBody({ subscriptionId: INBOX_SUBSCRIPTION_ID, generation: 3, streams }),
		);
		expect(staleProxied.json).toMatchObject({ acked: 'stale' });
		expect(h.callbacks).toEqual([]);
	});

	it('acks an agents-server wake through its callback, never with {done:true}', async () => {
		const h = await setup();
		const receipt = await messageBob(h, 'm-proxied');
		const bob = h.world.entity(BOB);
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
		expect(proxied).toEqual({ status: 200, json: { ok: true, entities: ['agent/bob'], acked: 'callback' } });
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
		expect((await bob.requireHost().waitForSettlement(receipt.submissionId, context)).outcome).toBe('completed');

		// A FENCED callback (a newer wake took over) is fine: the work is admitted.
		h.callbackResponse = () => Response.json({ error: { code: 'FENCED', message: 'stale' } }, { status: 409 });
		const fenced = await h.deliver(
			agentsServerWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 12,
				streams: [{ path: inboxPath(BOB), tailOffset: offset }],
			}),
		);
		expect(fenced.json).toMatchObject({ acked: 'fenced' });
	});

	it('redelivers when an entity wake fails', async () => {
		const h = await setup();
		await messageBob(h, 'm-1');
		const route = createEntityWakeRoute({
			keys: staticWebhookKeys({ keys: [h.signer.jwk] }),
			wake: async () => {
				throw new Error('DO unavailable');
			},
			now: () => h.world.clock.now,
		});
		const response = await route.fetch(
			await h.signer.request(
				WAKE_URL,
				durableStreamsWakeBody({
					subscriptionId: INBOX_SUBSCRIPTION_ID,
					generation: 1,
					streams: [{ path: inboxPath(BOB), tailOffset: await tail(h.log, inboxPath(BOB)) }],
				}),
				h.world.clock.now,
			),
		);
		expect(response.status).toBe(503);
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
		const first = await runtime.lifecycle.spawn('worker', { key: 'w1', initialData: { n: 1 } }, context);
		expect(first).toEqual({ ...child, uid });
		expect(await runtime.lifecycle.spawn('worker', { key: 'w1', initialData: { n: 1 } }, context)).toEqual(first);
		await alice.flush();
		const inbox = await readAll(h.log, inboxPath(child));
		expect(inbox).toEqual([
			expect.objectContaining({ from: ALICE, directive: { kind: 'spawn', uid, initialData: { n: 1 } } }),
		]);
		// The child's streams exist before anything was sent to them.
		expect(await h.log.head(`flue/v1/worker/${encodeURIComponent('alice/w1')}/events`)).not.toBeNull();

		const woken = await h.deliver(
			durableStreamsWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 1,
				streams: [{ path: inboxPath(child), tailOffset: await tail(h.log, inboxPath(child)) }],
			}),
		);
		expect(woken.json).toMatchObject({ done: true, entities: [entityKey(child)] });
		const worker = h.world.entity(child);
		const submissionId = await deriveKeyedSubmissionId(child.type, child.id, (inbox[0] as { messageId: string }).messageId);
		expect((await worker.requireHost().waitForSettlement(submissionId, context)).outcome).toBe('completed');
		const instance = await worker.requireHost().harness.snapshot(FlueInstance, context);
		expect(instance).toMatchObject({ uid, initialData: { value: { n: 1 } } });

		// Spawning the same key again after birth sends nothing.
		expect(await runtime.lifecycle.spawn('worker', { key: 'w1', initialData: { n: 1 } }, context)).toEqual(first);
		await alice.flush();
		expect(await readAll(h.log, inboxPath(child))).toHaveLength(1);
	});

	it('a self-schedule fires once, across a reopen', async () => {
		const h = await setup();
		const alice = h.world.entity(ALICE);
		const runtime = await alice.open();
		const at = h.world.clock.now + 60_000;
		await runtime.lifecycle.schedule(ALICE, at, { text: 'remind me' }, { scheduleId: 'r1' }, context);
		expect(alice.wakes).toContainEqual({ atMs: at, reason: { kind: 'schedule', scheduleId: 'r1' } });
		await runtime.wake({ kind: 'schedule', scheduleId: 'r1' }, context);
		expect(await alice.requireHost().settlement(scheduleSubmissionId('r1'), context)).toBeUndefined();

		await alice.close();
		h.world.clock.now = at + 1;
		const reopened = await alice.open();
		await reopened.wake({ kind: 'schedule', scheduleId: 'r1' }, context);
		expect((await alice.requireHost().waitForSettlement(scheduleSubmissionId('r1'), context)).outcome).toBe(
			'completed',
		);
		const calls = alice.calls;
		await reopened.wake({ kind: 'schedule', scheduleId: 'r1' }, context);
		await alice.close();
		await (await alice.open()).wake({ kind: 'schedule', scheduleId: 'r1' }, context);
		await alice.requireHost().harness.waitForIdle(context);
		expect(alice.calls).toBe(calls);
	});

	it("schedules another entity through its inbox; the target arms and fires its own copy", async () => {
		const h = await setup();
		const alice = h.world.entity(ALICE);
		const runtime = await alice.open();
		const at = h.world.clock.now + 5_000;
		await runtime.lifecycle.schedule(BOB, at, { text: 'standup' }, { scheduleId: 's1' }, context);
		await alice.flush();
		await h.deliver(
			durableStreamsWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 1,
				streams: [{ path: inboxPath(BOB), tailOffset: await tail(h.log, inboxPath(BOB)) }],
			}),
		);
		const bob = h.world.entity(BOB);
		const key = relayedScheduleKey(ALICE, 's1');
		expect(bob.wakes).toContainEqual({ atMs: at, reason: { kind: 'schedule', scheduleId: key } });
		expect(bob.calls).toBe(0);
		await bob.close();
		h.world.clock.now = at;
		await (await bob.open()).wake({ kind: 'schedule', scheduleId: key }, context);
		expect((await bob.requireHost().waitForSettlement(scheduleSubmissionId(key), context)).outcome).toBe(
			'completed',
		);
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
		const item = (n: number) => ({ type: 'society.observation', v: 1, source: 'rsshub', id: `hn-${n}`, title: `Story ${n}` });
		let seq = 0;
		const publish = async (n: number) => {
			const outcome = await h.log.append(world, { messages: [item(n)], producer: { id: 'rsshub', epoch: 0, seq: seq++ } });
			expect(outcome.status).toBe('appended');
		};
		await publish(1);
		await publish(2);

		const alice = h.world.entity(ALICE);
		const bob = h.world.entity(BOB);
		const runtime = await alice.open();
		await bob.open();
		expect(await runtime.observation.observe({ stream: world }, { key: 'hn', wake: true }, context)).toEqual({
			key: 'hn',
			offset: '-1',
		});
		expect(observedCalls).toEqual([{ entity: 'agent/alice', streams: [world] }]);

		const wake = (generation: number, tailOffset: string) =>
			h.deliver(
				durableStreamsWakeBody({
					subscriptionId: observeSubscriptionId(ALICE),
					generation,
					streams: [{ path: world, tailOffset }],
				}),
			);
		expect((await wake(1, await tail(h.log, world))).json).toMatchObject({ done: true, entities: ['agent/alice'] });
		const observed = async (entity: TestEntity) =>
			(await entity.entries()).filter((entry) => entry.kind === 'flue.observed').map((entry) => entry.data);
		// Write submissions are placed by the Pi inbox; wait for them.
		const observedCount = (entity: TestEntity, count: number) =>
			eventually(async () => ((await observed(entity)).length >= count ? true : undefined), {
				what: `${count} observed entries`,
			});
		await observedCount(alice, 2);
		expect(await observed(alice)).toEqual([
			expect.objectContaining({ key: 'hn', stream: world, index: 0, item: item(1) }),
			expect.objectContaining({ key: 'hn', stream: world, index: 1, item: item(2) }),
		]);
		expect(await observed(bob)).toEqual([]);
		expect(runtime.observation.cursors.value?.hn?.offset).toBe(await tail(h.log, world));

		// A duplicate wake records nothing new; a new item is recorded once.
		expect((await wake(1, await tail(h.log, world))).json).toMatchObject({ done: true });
		await publish(3);
		expect((await wake(2, await tail(h.log, world))).json).toMatchObject({ done: true });
		await observedCount(alice, 3);
		expect((await observed(alice)).map((data) => (data as { item: { id: string } }).item.id)).toEqual([
			'hn-1',
			'hn-2',
			'hn-3',
		]);

		// The same stream on the inbox subscription is nobody's inbox: it wakes no one.
		const before = h.world.woken.length;
		const unowned = await h.deliver(
			durableStreamsWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 9,
				streams: [{ path: world, tailOffset: await tail(h.log, world) }],
			}),
		);
		expect(unowned.json).toMatchObject({ done: true, entities: [] });
		expect(h.world.woken.length).toBe(before);
		expect(h.world.woken.every((woken) => woken.entity === 'agent/alice')).toBe(true);
	});
});
