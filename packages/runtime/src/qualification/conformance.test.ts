/**
 * Crash / replay / concurrency conformance for Flue entities on Pi Durable
 * (nymph-ai/nymphai #3755), hermetic: real FluePiHosts and entity runtimes on
 * pi-ai's faux provider, each over its own SQLite file (the record), with
 * entity events on each stream backend —
 *
 * - `memory`: the in-memory reference log;
 * - `bridge (SQL store)`: a Node app's own persistence adapter
 *   (`SqliteConversationStreamStore` behind `conversationStreamStoreLog`);
 * - `durable-streams server`: the reference server, when
 *   `scripts/test-durable-streams-server.sh` runs the suite (`FLUE_DS_URL`).
 *
 * A crash is a kill switch on one incarnation of an entity: from the chosen
 * point on, its database and stream calls all throw, and the entity is
 * reopened from its SQLite file as a new incarnation — what a Durable Object
 * eviction or isolate crash leaves behind.
 *
 * Scenario letters follow the live qualification (fabric/society/qualification):
 * b eviction mid-turn, c crash around a send, e eviction keeps state and the
 * public history, f fork, g wake routing, j backend swap. The log-only
 * scenarios (producer fencing, rebuild from the log, split brain) left with
 * the Pi log (docs/cloudflare-native.md rule 2).
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { afterEach, describe, expect, it } from 'vitest';
import {
	durableStreamsWakeBody,
	eventually,
	removeTempFiles,
	type TestEntity,
	type TestWorld,
	textOf,
	type Fault,
} from '../entity/a2a-test-support.ts';
import { entityKey, eventsPath, inboxPath, INBOX_SUBSCRIPTION_ID } from '../entity/paths.ts';
import type { EntityRef } from '../entity/services.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import {
	type BackendSpec,
	backends,
	context,
	normalizeIds,
	type QualWorld,
	qualWorld,
	readAll,
	societyResponder,
	transcript,
} from './conformance-support.ts';

const TIMEOUT = 60_000;

const worlds: TestWorld[] = [];

afterEach(async () => {
	for (const world of worlds) await world.closeAll().catch(() => {});
	worlds.length = 0;
	await removeTempFiles();
});

async function setup(spec: BackendSpec): Promise<QualWorld> {
	const qw = await qualWorld(spec.make());
	worlds.push(qw.world);
	return qw;
}

let submissionCounter = 0;

async function prompt(entity: TestEntity, body: string): Promise<string> {
	const submissionId = `sub_q${submissionCounter++}`;
	await admit(entity, submissionId, body);
	return submissionId;
}

async function admit(entity: TestEntity, submissionId: string, body: string): Promise<void> {
	await entity.requireHost().admit(
		{
			submissionId,
			kind: 'dispatch',
			message: { kind: 'user', body },
			acceptedAt: new Date(entity.world.clock.now).toISOString(),
			whenBusy: 'followUp',
		},
		context,
	);
}

/** Crash an entity's turn with `fault`, reopen it, and let Pi finish the work. */
async function crashAndRecover(qw: QualWorld, fault: Fault, body: string) {
	const alice = qw.world.entity(qw.ref('agent', 'alice'), societyResponder);
	await alice.open();
	// Armed once the instance is open: the crash lands in the turn, not in the boot.
	alice.arm(fault);
	const first = alice.incarnation;
	if (!first) throw new Error('alice is not open');
	const submissionId = `sub_q${submissionCounter++}`;
	// The fault may fire inside admission itself (between its two commits):
	// the caller then sees the crash, and the next incarnation repairs it.
	await admit(alice, submissionId, body).catch((error: unknown) => {
		if (!first.dead) throw error;
	});
	await eventually(() => first.dead, {
		what: `the ${fault.kind} fault to fire`,
		timeoutMs: 20_000,
	});
	expect(first.fired).toEqual(fault);
	await alice.open();
	const second = alice.incarnation;
	expect(second).not.toBe(first);
	await alice.requireHost().wake({ kind: 'live-tasks' }, context);
	const settlement = await alice.requireHost().waitForSettlement(submissionId, context);
	return { alice, first, second, submissionId, settlement };
}

/** The distinct rounds an entity's events stream carries, by event id. */
async function rounds(qw: QualWorld, ref: EntityRef) {
	const byId = new Map<string, number | undefined>();
	for (const message of await readAll(qw.log, eventsPath(ref))) {
		const event = message as { eventId: string; event?: { round?: number } };
		byId.set(event.eventId, event.event?.round);
	}
	return [...byId.values()];
}

async function wakeInbox(qw: QualWorld, ref: EntityRef, generation = 1) {
	return qw.deliver(
		durableStreamsWakeBody({
			subscriptionId: INBOX_SUBSCRIPTION_ID,
			generation,
			streams: [
				{
					path: inboxPath(ref),
					tailOffset: (await qw.log.head(inboxPath(ref)))?.nextOffset ?? '-1',
				},
			],
		}),
	);
}

describe.each(backends())('conformance over $name', (backend) => {
	describe('b. eviction during a Pi turn', () => {
		it.each([2, 8, 14])(
			'aborted after %i commits, the turn resumes with nothing lost or done twice',
			async (after) => {
				const qw = await setup(backend);
				const { alice, settlement } = await crashAndRecover(
					qw,
					{ kind: 'abort-after-commits', after },
					'chain 3',
				);
				expect(settlement.outcome).toBe('completed');
				// Each round's event is out, under one id each (a replayed publish appends the same id).
				expect(await rounds(qw, alice.ref)).toEqual([1, 2, 3]);
				const texts = (await transcript(alice)).map((entry) => entry.text);
				expect(texts.filter((text) => text === 'Chain of 3 published.')).toHaveLength(1);
			},
			TIMEOUT,
		);
	});

	describe('c. crash around a send', () => {
		it.each(['crash-before-send', 'crash-after-send'] as const)(
			'%s: the receiver admits the message exactly once',
			async (kind) => {
				const qw = await setup(backend);
				const bobRef = qw.ref('agent', 'bob');
				const bob = qw.world.entity(bobRef, societyResponder);
				const { first, settlement } = await crashAndRecover(
					qw,
					{ kind, after: 0 },
					`send agent/${bobRef.id} hello`,
				);
				expect(settlement.outcome).toBe('completed');
				expect(first.appends.at(-1)?.outcome).toBe(
					kind === 'crash-before-send' ? 'thrown' : 'appended',
				);
				const inbox = (await readAll(qw.log, inboxPath(bobRef))) as { messageId: string }[];
				// After the POST the replay sends the same event again; before it, once.
				expect(inbox).toHaveLength(kind === 'crash-after-send' ? 2 : 1);
				expect(new Set(inbox.map((message) => message.messageId)).size).toBe(1);

				await wakeInbox(qw, bobRef);
				await qw.world.runAlarms();
				const submissionId = await deriveKeyedSubmissionId(
					bobRef.type,
					bobRef.id,
					inbox[0]?.messageId ?? '',
				);
				expect((await bob.requireHost().waitForSettlement(submissionId, context)).outcome).toBe(
					'completed',
				);
				await bob.requireHost().harness.waitForIdle(context);
				const inputs = (
					await bob.requireStorage().scanSubmissions({}, 1000, undefined, context)
				).items.filter((submission) => submission.type === 'input');
				expect(inputs.map((submission) => submission.requestId)).toEqual([submissionId]);
			},
			TIMEOUT,
		);
	});

	describe('e. eviction keeps the record', () => {
		it(
			'closing and reopening gives the same Pi history and the same public conversation',
			async () => {
				const qw = await setup(backend);
				const alice = qw.world.entity(qw.ref('agent', 'alice'), societyResponder);
				const bob = qw.world.entity(qw.ref('agent', 'bob'), societyResponder);
				await alice.open();
				const turn = await prompt(alice, `send agent/${bob.ref.id} ping`);
				expect((await alice.requireHost().waitForSettlement(turn, context)).outcome).toBe(
					'completed',
				);
				expect((await wakeInbox(qw, bob.ref)).status).toBe(200);
				await qw.world.runAlarms();
				const ping = (await readAll(qw.log, inboxPath(bob.ref)))[0] as { messageId: string };
				const bobTurn = await deriveKeyedSubmissionId(bob.ref.type, bob.ref.id, ping.messageId);
				expect((await bob.requireHost().waitForSettlement(bobTurn, context)).outcome).toBe(
					'completed',
				);

				for (const entity of [alice, bob]) {
					await entity.requireHost().harness.waitForIdle(context);
					const before = await transcript(entity);
					await entity.close();
					await entity.open();
					expect((await transcript(entity)).slice(0, before.length)).toEqual(before);
				}
			},
			TIMEOUT,
		);
	});

	describe('f. fork', () => {
		it(
			'a fork keeps its source history up to the fork point and diverges',
			async () => {
				const qw = await setup(backend);
				const alice = qw.world.entity(qw.ref('agent', 'alice'), societyResponder);
				await alice.open();
				const first = await prompt(alice, 'first question');
				await alice.requireHost().waitForSettlement(first, context);
				const harness = alice.requireHost().harness;
				const root = await harness.root(context);
				const before = await alice.entries();
				const forkPoint = before.at(-1);
				if (!forkPoint) throw new Error('no entries');
				const fork = await root.fork(forkPoint.id, { ownership: { kind: 'ownerless' } }, context);
				const onFork = await fork.submit(
					{ type: 'input', content: 'a question only the fork hears', requestId: 'fork-1' },
					context,
				);
				expect((await onFork.wait(context)).status).toBe('done');
				const onRoot = await prompt(alice, 'a question only the source hears');
				await alice.requireHost().waitForSettlement(onRoot, context);

				const source = await alice.entries(ROOT_CONVERSATION_ID);
				const branch = await alice.entries(fork.id);
				const texts = (entries: typeof source) => entries.map((entry) => textOf(entry.model?.[0]));
				expect(source.slice(0, before.length)).toEqual(before);
				expect(branch.slice(0, before.length).map((entry) => entry.id)).toEqual(
					before.map((entry) => entry.id),
				);
				expect(texts(branch.slice(before.length))).toEqual(
					expect.arrayContaining(['a question only the fork hears']),
				);
				expect(texts(branch)).not.toContain('a question only the source hears');
				expect(texts(source)).not.toContain('a question only the fork hears');
			},
			TIMEOUT,
		);
	});

	describe('g. A2A wake routing', () => {
		it(
			'a send to one of many sleeping entities rings exactly that one, and a redelivery admits nothing new',
			async () => {
				const qw = await setup(backend);
				const alice = qw.world.entity(qw.ref('agent', 'alice'), societyResponder);
				const crowd = Array.from({ length: 12 }, (_, index) =>
					qw.world.entity(qw.ref('agent', `bob-${index}`), societyResponder),
				);
				const runtime = await alice.open();
				const targets = [crowd[3], crowd[9]] as TestEntity[];
				for (const target of targets) {
					await runtime.messaging.send(
						target.ref,
						{ text: 'hello' },
						{ messageId: `to-${target.ref.id}` },
						context,
					);
				}
				for (const entity of crowd) await qw.log.ensure(inboxPath(entity.ref));

				// One wake listing every inbox the glob matches; only two are pending.
				const streams = await Promise.all(
					[alice, ...crowd].map(async (entity) => ({
						path: inboxPath(entity.ref),
						tailOffset: (await qw.log.head(inboxPath(entity.ref)))?.nextOffset ?? '-1',
						pending: targets.includes(entity),
					})),
				);
				const body = durableStreamsWakeBody({
					subscriptionId: INBOX_SUBSCRIPTION_ID,
					generation: 1,
					streams,
				});
				expect((await qw.deliver(body)).json).toMatchObject({ ok: true, acked: 'callback' });
				const rung = () =>
					qw.world.woken.reduce<Record<string, number>>((counts, wake) => {
						counts[wake.entity] = (counts[wake.entity] ?? 0) + 1;
						return counts;
					}, {});
				expect(rung()).toEqual(
					Object.fromEntries(targets.map((entity) => [entityKey(entity.ref), 1])),
				);
				// Ringing opens nothing; the alarms do.
				expect(crowd.filter((entity) => entity.isOpen)).toEqual([]);
				await qw.world.runAlarms();
				expect(crowd.filter((entity) => entity.isOpen)).toEqual(targets);

				const submissions = async (entity: TestEntity) =>
					(await entity.requireStorage().scanSubmissions({}, 1000, undefined, context)).items
						.length;
				for (const entity of targets) await entity.requireHost().harness.waitForIdle(context);
				const counts = await Promise.all(targets.map(submissions));
				expect((await qw.deliver(body)).json).toMatchObject({ ok: true });
				await qw.world.runAlarms();
				for (const entity of targets) await entity.requireHost().harness.waitForIdle(context);
				expect(await Promise.all(targets.map(submissions))).toEqual(counts);
				expect(crowd.filter((entity) => entity.isOpen)).toEqual(targets);
			},
			TIMEOUT,
		);
	});
});

describe('j. backend swap', () => {
	/** One scenario's public results: settlements, histories, inbox texts, events. */
	async function run(spec: BackendSpec) {
		const qw = await setup(spec);
		const alice = qw.world.entity(qw.ref('agent', 'alice'), societyResponder);
		const bob = qw.world.entity(qw.ref('agent', 'bob'), societyResponder);
		await alice.open();
		const turns = [
			await prompt(alice, 'chain 2'),
			await prompt(alice, `send agent/${bob.ref.id} ping`),
		];
		const outcomes = [];
		for (const turn of turns)
			outcomes.push((await alice.requireHost().waitForSettlement(turn, context)).outcome);
		const ping = (await readAll(qw.log, inboxPath(bob.ref)))[0] as { messageId: string };
		await wakeInbox(qw, bob.ref);
		await qw.world.runAlarms();
		const bobTurn = await deriveKeyedSubmissionId(bob.ref.type, bob.ref.id, ping.messageId);
		outcomes.push((await bob.requireHost().waitForSettlement(bobTurn, context)).outcome);
		await bob.requireHost().harness.waitForIdle(context);
		const prefix = qw.backend.idPrefix;
		return {
			outcomes,
			alice: normalizeIds(await transcript(alice), prefix),
			bob: normalizeIds(await transcript(bob), prefix),
			inboxes: {
				bob: normalizeIds(await readAll(qw.log, inboxPath(bob.ref)), prefix),
				alice: normalizeIds(await readAll(qw.log, inboxPath(alice.ref)), prefix),
			},
			events: normalizeIds(await readAll(qw.log, eventsPath(alice.ref)), prefix),
		};
	}

	it(
		'the same scenario has identical public results on every backend',
		async () => {
			const all = backends();
			const baseline = await run(all[0] as BackendSpec);
			expect(baseline.outcomes).toEqual(['completed', 'completed', 'completed']);
			expect(baseline.inboxes.alice).toHaveLength(1);
			for (const backend of all.slice(1)) {
				expect({ backend: backend.name, ...(await run(backend)) }).toEqual({
					backend: backend.name,
					...baseline,
				});
			}
		},
		TIMEOUT * 2,
	);
});
