/**
 * Crash / replay / concurrency conformance for Flue + Pi Durable + a Durable
 * Streams log (nymph-ai/nymphai #3755), hermetic: real FluePiHosts and entity
 * runtimes on pi-ai's faux provider, over each log backend —
 *
 * - `memory`: the in-memory reference log (Durable Streams producer and
 *   Stream-Seq rules, exactly);
 * - `bridge (DO SQLite)`: the log a deployment without Electric keeps in its
 *   Durable Object's SQLite (`SqliteConversationStreamStore` behind
 *   `conversationStreamStoreLog`), over node:sqlite;
 * - `durable-streams server`: the reference server, when
 *   `scripts/test-durable-streams-server.sh` runs the suite (`FLUE_DS_URL`).
 *
 * A crash is a kill switch on one incarnation of an entity: from the chosen
 * append on, its database and log calls all throw, and the entity is reopened
 * from its SQLite file as a new incarnation — what a Durable Object eviction
 * or isolate crash leaves behind.
 *
 * Scenario letters follow the live qualification (fabric/society/qualification):
 * b eviction mid-turn, c crash around the append ack, d producer fencing,
 * e replay, f fork, g wake routing, j backend swap. The Fabric-admission
 * scenarios of #3755 are not here: the Fabric↔Electric bridge (#3754) does
 * not exist yet.
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { afterEach, describe, expect, it } from 'vitest';
import {
	durableStreamsWakeBody,
	eventually,
	TestEntity,
	type TestWorld,
	textOf,
} from '../entity/a2a-test-support.ts';
import { entityKey, eventsPath, inboxPath, INBOX_SUBSCRIPTION_ID } from '../entity/paths.ts';
import type { EntityRef } from '../entity/services.ts';
import { piConversationSource } from '../pi/projection-host.ts';
import {
	openStreamStorage,
	removeTempFiles,
	snapshotReads,
	tempFile,
} from '../pi/stream-storage-test-support.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import {
	type Backend,
	backends,
	context,
	contiguous,
	type Fault,
	loggedEnvelopes,
	normalizeIds,
	type QualWorld,
	qualWorld,
	readAll,
	seqsOf,
	societyResponder,
	transcript,
} from './conformance-support.ts';

const TIMEOUT = 60_000;

/** `QUAL_TRACE=1`: progress on stderr, outside vitest's buffering (a run that dies leaves its trail). */
function trace(message: string): void {
	if (process.env.QUAL_TRACE) process.stderr.write(`[conformance] ${message}\n`);
}

if (process.env.QUAL_TRACE) {
	setInterval(() => {
		const { heapUsed, rss } = process.memoryUsage();
		trace(`heap ${Math.round(heapUsed / 1e6)} MB, rss ${Math.round(rss / 1e6)} MB`);
	}, 2000).unref();
}

/** Trace a failing step's error before vitest buffers it (an OOM later would lose it). */
async function traced<T>(what: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		trace(`${what} failed: ${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.split('\n').slice(1, 6).join('\n')}` : String(error)}`);
		throw error;
	}
}
const worlds: TestWorld[] = [];

afterEach(async () => {
	for (const world of worlds) await world.closeAll().catch(() => {});
	worlds.length = 0;
	await removeTempFiles();
});

async function setup(backend: Backend): Promise<QualWorld> {
	const qw = await qualWorld(backend);
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

function piPath(ref: EntityRef): string {
	return `flue/v1/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}/pi`;
}

/** A log client whose identity is new, so projections over it start cold. */
function freshClient(log: DurableStreamLog): DurableStreamLog {
	return {
		ensure: (path, signal) => log.ensure(path, signal),
		append: (path, input, signal) => log.append(path, input, signal),
		read: (path, from, options) => log.read(path, from, options),
		head: (path, signal) => log.head(path, signal),
	};
}

/** Every Pi read of `entity`'s live index equals a rebuild of its log into a fresh database. */
async function expectReplaysIdentically(qw: QualWorld, entity: TestEntity): Promise<void> {
	await entity.flush();
	const seq = entity.lastSeq();
	const live = await snapshotReads(entity.requireStorage(), seq);
	const rebuilt = await openStreamStorage({
		file: await tempFile(),
		log: qw.log,
		entity: entity.ref,
	});
	try {
		expect(rebuilt.fences).toEqual([]);
		expect(await snapshotReads(rebuilt.storage, seq)).toEqual(live);
	} finally {
		await rebuilt.storage.close(context);
	}
}

/** Each seq once, contiguous from 1: no lost and no duplicated Pi commit on the log. */
async function expectEachCommitOnce(qw: QualWorld, entity: TestEntity): Promise<number[]> {
	await entity.flush();
	const seqs = seqsOf(await loggedEnvelopes(qw.log, piPath(entity.ref)));
	expect(contiguous(seqs)).toBe(true);
	expect(seqs.at(-1)).toBe(entity.lastSeq());
	return seqs;
}

/** Crash an entity's turn with `fault`, reopen it, and let Pi finish the work. */
function crashAndRecover(qw: QualWorld, fault: Fault, body: string) {
	return traced(`${fault.kind}/${fault.after}`, () => crashAndRecoverNow(qw, fault, body));
}

async function crashAndRecoverNow(qw: QualWorld, fault: Fault, body: string) {
	trace(`${qw.backend.name}: ${fault.kind} after ${fault.after} on ${fault.stream}, "${body}"`);
	const alice = qw.world.entity(qw.ref('agent', 'alice'), societyResponder);
	qw.arm(alice, fault);
	await alice.open();
	const first = qw.incarnation(alice);
	const submissionId = `sub_q${submissionCounter++}`;
	// The fault may fire inside admission itself (between its two commits):
	// the caller then sees the crash, and the next incarnation repairs it.
	const admission = admit(alice, submissionId, body).then(
		() => 'admitted' as const,
		(error: unknown) => {
			if (first.dead) return 'crashed during admission' as const;
			throw error;
		},
	);
	try {
		await eventually(() => first.dead, {
			what: `the ${fault.kind} fault to fire`,
			timeoutMs: 20_000,
		});
	} catch (error) {
		const outcomes: Record<string, number> = {};
		for (const append of first.appends) {
			const key = `${append.path.split('/').at(-1)}:${append.outcome}`;
			outcomes[key] = (outcomes[key] ?? 0) + 1;
		}
		trace(
			`the fault never fired: ${first.appends.length} appends ${JSON.stringify(outcomes)}, ${alice.calls} model calls, admission ${await Promise.race([admission, Promise.resolve('pending')])}`,
		);
		alice.abandon();
		throw error;
	}
	expect(first.fired).toEqual(fault);
	const admitted = await admission;
	trace(`fired after ${first.appends.length} appends, ${alice.calls} model calls, ${admitted}; reopening`);
	alice.abandon();

	await alice.open();
	const second = qw.incarnation(alice);
	expect(second.dead).toBe(false);
	await alice.requireHost().wake({ kind: 'live-tasks' }, context);
	trace('reopened; waiting for the settlement');
	const settlement = await alice.requireHost().waitForSettlement(submissionId, context);
	trace(`settled ${settlement.outcome} after ${alice.calls} model calls`);
	await alice.flush();
	return { alice, first, second, submissionId, settlement, admitted };
}

async function events(qw: QualWorld, ref: EntityRef) {
	return (await readAll(qw.log, eventsPath(ref))).map((message) => {
		const event = (message as { event?: { round?: number } }).event;
		return event?.round;
	});
}

describe.each(backends())('conformance over $name', (backend) => {
	describe('b. eviction during a Pi turn', () => {
		it.each([1, 3, 6])(
			'aborted after %i acknowledged commits, the turn resumes with nothing lost or done twice',
			async (after) => {
				const qw = await setup(backend);
				const { alice, settlement } = await crashAndRecover(
					qw,
					{ kind: 'abort-after-commits', after, stream: 'pi' },
					'chain 3',
				);
				expect(settlement.outcome).toBe('completed');
				// Each round's event went out exactly once.
				expect(await events(qw, alice.ref)).toEqual([1, 2, 3]);
				const texts = (await transcript(alice)).map((entry) => entry.text);
				expect(texts.filter((text) => text === 'Chain of 3 published.')).toHaveLength(1);
				await expectEachCommitOnce(qw, alice);
				await expectReplaysIdentically(qw, alice);
			},
			TIMEOUT,
		);
	});

	describe('c. crash around the Electric append acknowledgement', () => {
		it.each([0, 2])(
			'crash after the local commit, before the POST (after %i appends): published once on reopen',
			async (after) => {
				const qw = await setup(backend);
				const { alice, first, settlement } = await crashAndRecover(
					qw,
					{ kind: 'crash-before-post', after, stream: 'pi' },
					'chain 2',
				);
				expect(first.appends.at(-1)?.outcome).toBe('thrown');
				expect(settlement.outcome).toBe('completed');
				expect(await events(qw, alice.ref)).toEqual([1, 2]);
				await expectEachCommitOnce(qw, alice);
				await expectReplaysIdentically(qw, alice);
			},
			TIMEOUT,
		);

		it.each([0, 2])(
			'crash after the POST, before the ack (after %i appends): the retry is a duplicate, never a second commit',
			async (after) => {
				const qw = await setup(backend);
				const { alice, first, second, settlement } = await crashAndRecover(
					qw,
					{ kind: 'crash-after-post', after, stream: 'pi' },
					'chain 2',
				);
				const lost = first.appends.at(-1);
				expect(lost?.outcome).toBe('thrown');
				// The new incarnation re-sends the row the dead one never heard back
				// about, under the same producer claim: the server says duplicate.
				const retry = second.appends.find(
					(append) => append.path.endsWith('/pi') && append.streamSeq === lost?.streamSeq,
				);
				expect(retry).toMatchObject({ producer: lost?.producer, outcome: 'duplicate' });
				expect(settlement.outcome).toBe('completed');
				expect(await events(qw, alice.ref)).toEqual([1, 2]);
				await expectEachCommitOnce(qw, alice);
				await expectReplaysIdentically(qw, alice);
			},
			TIMEOUT,
		);

		it(
			'crash after an A2A relay POST, before its ack: the message is in the inbox once',
			async () => {
				const qw = await setup(backend);
				const bob = qw.ref('agent', 'bob');
				const { alice, settlement } = await crashAndRecover(
					qw,
					{ kind: 'crash-after-post', after: 0, stream: 'inbox' },
					`send agent/${bob.id} ping`,
				);
				expect(settlement.outcome).toBe('completed');
				await alice.flush();
				const inbox = await readAll(qw.log, inboxPath(bob));
				expect(inbox).toHaveLength(1);
				expect(inbox[0]).toMatchObject({ type: 'flue.a2a.message', message: { text: 'ping' } });
				await expectEachCommitOnce(qw, alice);
			},
			TIMEOUT,
		);
	});

	describe('d. idempotent producer retry and stale-producer rejection', () => {
		it(
			'on the log itself: a retry is a duplicate, a gap is reported, an older epoch is fenced',
			async () => {
				const qw = await setup(backend);
				const path = `${backend.idPrefix}qual/producer-${submissionCounter++}`;
				await qw.log.ensure(path);
				const append = (epoch: number, seq: number, streamSeq: string, n: number) =>
					qw.log.append(path, {
						messages: [{ n }],
						producer: { id: 'qual-producer', epoch, seq },
						streamSeq,
					});
				expect((await append(0, 0, '0000000000000001', 1)).status).toBe('appended');
				expect((await append(0, 0, '0000000000000001', 1)).status).toBe('duplicate');
				expect((await append(0, 1, '0000000000000002', 2)).status).toBe('appended');
				expect(await append(0, 5, '0000000000000003', 3)).toMatchObject({
					status: 'producer-gap',
					expectedSeq: 2,
				});
				expect((await append(1, 0, '0000000000000003', 3)).status).toBe('appended');
				expect(await append(0, 2, '0000000000000004', 4)).toMatchObject({
					status: 'fenced',
					currentEpoch: 1,
				});
				expect((await append(1, 1, '0000000000000002', 2)).status).toBe('stream-seq-conflict');
				expect(await readAll(qw.log, path)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
			},
			TIMEOUT,
		);

		it(
			'two writers of one entity: the newer takes the next epoch, the older is fenced and stops',
			async () => {
				const qw = await setup(backend);
				const ref = qw.ref('agent', 'zombie');
				const older = qw.world.entity(ref, societyResponder);
				await older.open();
				const firstTurn = await prompt(older, 'hello');
				expect((await older.requireHost().waitForSettlement(firstTurn, context)).outcome).toBe(
					'completed',
				);
				await older.flush();

				// A second Durable Object for the same entity (split brain): a fresh
				// database rebuilt from the log, which takes the next producer epoch.
				const newer = new TestEntity(qw.world, ref, societyResponder);
				await newer.open();
				const newerTurn = await prompt(newer, 'from the newer writer');
				expect((await newer.requireHost().waitForSettlement(newerTurn, context)).outcome).toBe(
					'completed',
				);
				await newer.flush();
				expect(newer.fences).toEqual([]);

				// The older writer commits locally (Storage's contract), then is fenced on publish.
				await prompt(older, 'from the older writer').catch(() => undefined);
				await eventually(() => older.fences.length > 0, { what: 'the older writer to be fenced' });
				expect(older.fences[0]?.reason).toMatch(/epoch|diverged/);
				await expect(prompt(older, 'after the fence')).rejects.toThrow();

				const envelopes = await loggedEnvelopes(qw.log, piPath(ref));
				expect(contiguous(seqsOf(envelopes))).toBe(true);
				// Nothing the older writer committed after the newer one took over is on the log.
				const epochs = envelopes.map((envelope) => (envelope as { epoch?: number }).epoch ?? 0);
				const takeover = epochs.indexOf(1);
				expect(takeover).toBeGreaterThan(0);
				expect(epochs.slice(takeover).every((epoch) => epoch === 1)).toBe(true);
				await expectReplaysIdentically(qw, newer);
				await newer.close();
			},
			TIMEOUT,
		);
	});

	describe('e. stream replay', () => {
		it(
			'rebuilding from the log alone gives identical Pi Durable state and the same public history',
			async () => {
				const qw = await setup(backend);
				const alice = qw.world.entity(qw.ref('agent', 'alice'), societyResponder);
				const bob = qw.world.entity(qw.ref('agent', 'bob'), societyResponder);
				await alice.open();
				const turn = await prompt(alice, `send agent/${bob.ref.id} ping`);
				expect((await alice.requireHost().waitForSettlement(turn, context)).outcome).toBe(
					'completed',
				);
				await alice.flush();
				const ping = (await readAll(qw.log, inboxPath(bob.ref)))[0] as { messageId: string };
				const wakeBob = await qw.deliver(
					durableStreamsWakeBody({
						subscriptionId: INBOX_SUBSCRIPTION_ID,
						generation: 1,
						streams: [
							{
								path: inboxPath(bob.ref),
								tailOffset: (await qw.log.head(inboxPath(bob.ref)))?.nextOffset ?? '-1',
							},
						],
					}),
				);
				expect(wakeBob.status).toBe(200);
				const bobTurn = await deriveKeyedSubmissionId(bob.ref.type, bob.ref.id, ping.messageId);
				expect((await bob.requireHost().waitForSettlement(bobTurn, context)).outcome).toBe(
					'completed',
				);
				await bob.flush();

				for (const entity of [alice, bob]) {
					await expectReplaysIdentically(qw, entity);
					const path = piPath(entity.ref);
					const before = (await piConversationSource(freshClient(qw.log), path).head()).snapshot;
					await entity.close();
					await entity.open();
					const after = (await piConversationSource(freshClient(qw.log), path).head()).snapshot;
					expect(after).toEqual(before);
					await expectReplaysIdentically(qw, entity);
				}
			},
			TIMEOUT,
		);
	});

	describe('f. fork', () => {
		it(
			'a fork keeps its source history up to the fork point and diverges; both replay',
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
				// The source history is intact and the fork shares it up to the fork point.
				expect(source.slice(0, before.length)).toEqual(before);
				expect(branch.slice(0, before.length).map((entry) => entry.id)).toEqual(
					before.map((entry) => entry.id),
				);
				// Then they diverge.
				expect(texts(branch.slice(before.length))).toEqual(
					expect.arrayContaining(['a question only the fork hears']),
				);
				expect(texts(branch)).not.toContain('a question only the source hears');
				expect(texts(source)).not.toContain('a question only the fork hears');
				await expectEachCommitOnce(qw, alice);
				await expectReplaysIdentically(qw, alice);
			},
			TIMEOUT,
		);
	});

	describe('g. A2A wake routing', () => {
		it(
			'a send to one of many sleeping entities wakes exactly that one, once per delivery',
			async () => {
				const qw = await setup(backend);
				const alice = qw.world.entity(qw.ref('agent', 'alice'), societyResponder);
				const crowd = Array.from({ length: 12 }, (_, index) =>
					qw.world.entity(qw.ref('agent', `bob-${index}`), societyResponder),
				);
				const runtime = await alice.open();
				for (const target of [crowd[3], crowd[9]] as TestEntity[]) {
					await runtime.messaging.send(
						target.ref,
						{ text: 'hello' },
						{ messageId: `to-${target.ref.id}` },
						context,
					);
				}
				await alice.flush();
				for (const entity of crowd) await qw.log.ensure(inboxPath(entity.ref));

				// One wake listing every inbox the glob matches; only two are pending.
				const streams = await Promise.all(
					[alice, ...crowd].map(async (entity) => ({
						path: inboxPath(entity.ref),
						tailOffset: (await qw.log.head(inboxPath(entity.ref)))?.nextOffset ?? '-1',
						pending: entity === crowd[3] || entity === crowd[9],
					})),
				);
				const body = durableStreamsWakeBody({
					subscriptionId: INBOX_SUBSCRIPTION_ID,
					generation: 1,
					streams,
				});
				expect((await qw.deliver(body)).json).toMatchObject({ done: true });
				const woken = () =>
					qw.world.woken.reduce<Record<string, number>>((counts, wake) => {
						counts[wake.entity] = (counts[wake.entity] ?? 0) + 1;
						return counts;
					}, {});
				const targets = [crowd[3], crowd[9]] as TestEntity[];
				expect(woken()).toEqual(
					Object.fromEntries(targets.map((entity) => [entityKey(entity.ref), 1])),
				);
				expect(crowd.filter((entity) => entity.isOpen)).toEqual(targets);

				// A redelivery wakes the same two again and admits nothing new.
				const submissions = async (entity: TestEntity) =>
					(await entity.requireStorage().scanSubmissions({}, 1000, undefined, context)).items
						.length;
				for (const entity of targets) await entity.requireHost().harness.waitForIdle(context);
				const counts = await Promise.all(targets.map(submissions));
				expect((await qw.deliver(body)).json).toMatchObject({ done: true });
				expect(woken()).toEqual(
					Object.fromEntries(targets.map((entity) => [entityKey(entity.ref), 2])),
				);
				for (const entity of targets) await entity.requireHost().harness.waitForIdle(context);
				expect(await Promise.all(targets.map(submissions))).toEqual(counts);
				expect(crowd.filter((entity) => entity.isOpen)).toEqual(targets);
			},
			TIMEOUT,
		);
	});
});

describe('j. backend swap', () => {
	/** One scenario's public results: settlements, histories, inbox texts, events, commit counts. */
	async function run(backend: Backend) {
		const qw = await setup(backend);
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
		await alice.flush();
		const ping = (await readAll(qw.log, inboxPath(bob.ref)))[0] as { messageId: string };
		await qw.deliver(
			durableStreamsWakeBody({
				subscriptionId: INBOX_SUBSCRIPTION_ID,
				generation: 1,
				streams: [
					{
						path: inboxPath(bob.ref),
						tailOffset: (await qw.log.head(inboxPath(bob.ref)))?.nextOffset ?? '-1',
					},
				],
			}),
		);
		const bobTurn = await deriveKeyedSubmissionId(bob.ref.type, bob.ref.id, ping.messageId);
		outcomes.push((await bob.requireHost().waitForSettlement(bobTurn, context)).outcome);
		await bob.flush();
		const prefix = backend.idPrefix;
		const result = {
			outcomes,
			alice: normalizeIds(await transcript(alice), prefix),
			bob: normalizeIds(await transcript(bob), prefix),
			inboxes: {
				bob: normalizeIds(await readAll(qw.log, inboxPath(bob.ref)), prefix),
				alice: normalizeIds(await readAll(qw.log, inboxPath(alice.ref)), prefix),
			},
			events: normalizeIds(await readAll(qw.log, eventsPath(alice.ref)), prefix),
			commits: {
				alice: seqsOf(await loggedEnvelopes(qw.log, piPath(alice.ref))),
				bob: seqsOf(await loggedEnvelopes(qw.log, piPath(bob.ref))),
			},
		};
		await expectReplaysIdentically(qw, alice);
		await expectReplaysIdentically(qw, bob);
		return result;
	}

	it(
		'the same scenario has identical public results on every backend',
		async () => {
			const all = backends();
			const baseline = await run(all[0] as Backend);
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
