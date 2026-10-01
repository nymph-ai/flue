/**
 * Contract suite for {@link DurableStreamLog} implementations: the Durable
 * Streams write fences (PROTOCOL.md §5.2 `Stream-Seq`, §5.2.1 idempotent
 * producers), JSON-mode atomicity and flattening (§9.1), and opaque,
 * lexicographically ordered offsets (§8).
 *
 * ```ts
 * import { defineDurableStreamLogContractTests } from '@flue/runtime/test-utils/durable-stream-log';
 *
 * defineDurableStreamLogContractTests('my log', { create: () => new MyLog() });
 * ```
 *
 * Every test works on a fresh, uniquely named stream, so the suite can run
 * against a shared server (pass `pathPrefix` to keep runs apart).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	type AppendOutcome,
	type DurableStreamLog,
	DurableStreamLogError,
	type ProducerClaim,
} from '../streams/log.ts';
import { compareOffsets, STREAM_NOW, STREAM_START, type StreamOffset } from '../streams/offset.ts';

export interface DurableStreamLogContractBackend {
	create(): DurableStreamLog | Promise<DurableStreamLog>;
	cleanup?(): void | Promise<void>;
	/** Prepended to every stream path (default `"contract/"`). */
	pathPrefix?: string;
	/**
	 * Whether a long-poll parked at the tail returns promptly once data is
	 * appended (default true). Set false for a backend whose live reads only
	 * return on the server's timeout.
	 */
	liveWakes?: boolean;
}

function producer(id: string, epoch: number, seq: number): ProducerClaim {
	return { id, epoch, seq };
}

function expectAppended(
	outcome: AppendOutcome,
): asserts outcome is Extract<AppendOutcome, { status: 'appended' }> {
	expect(outcome.status).toBe('appended');
}

export function defineDurableStreamLogContractTests(
	label: string,
	backend: DurableStreamLogContractBackend,
): void {
	describe(label, () => {
		const prefix = backend.pathPrefix ?? 'contract/';
		const freshPath = () => `${prefix}${crypto.randomUUID()}`;

		afterEach(async () => {
			await backend.cleanup?.();
		});

		async function fresh(): Promise<{ log: DurableStreamLog; path: string; tail: StreamOffset }> {
			const log = await backend.create();
			const path = freshPath();
			const { nextOffset } = await log.ensure(path);
			return { log, path, tail: nextOffset };
		}

		async function all(log: DurableStreamLog, path: string): Promise<unknown[]> {
			const messages: unknown[] = [];
			let offset: StreamOffset = STREAM_START;
			while (true) {
				const batch = await log.read(path, offset);
				messages.push(...batch.messages);
				offset = batch.nextOffset;
				if (batch.upToDate) return messages;
			}
		}

		it('creates idempotently and reports the tail through head', async () => {
			const { log, path, tail } = await fresh();
			expect(await log.ensure(path)).toEqual({ nextOffset: tail });
			expect(await log.head(path)).toEqual({ nextOffset: tail, closed: false });
			expect(await log.head(freshPath())).toBeNull();
			expect(await log.read(path, STREAM_START)).toMatchObject({
				messages: [],
				nextOffset: tail,
				upToDate: true,
				closed: false,
			});
		});

		it('appends a new producer at seq 0 and advances the tail', async () => {
			const { log, path, tail } = await fresh();
			const outcome = await log.append(path, {
				messages: [{ n: 1 }],
				producer: producer('p', 0, 0),
			});
			expectAppended(outcome);
			expect(compareOffsets(outcome.nextOffset, tail)).toBe(1);
			expect(await log.head(path)).toEqual({ nextOffset: outcome.nextOffset, closed: false });
			expect(await all(log, path)).toEqual([{ n: 1 }]);
		});

		it('keeps one append atomic and flattens exactly one array level', async () => {
			const { log, path } = await fresh();
			const first = await log.append(path, {
				messages: [{ a: 1 }, [1, 2], 'text', null],
				producer: producer('p', 0, 0),
			});
			expectAppended(first);
			const second = await log.append(path, {
				messages: [{ b: 2 }],
				producer: producer('p', 0, 1),
			});
			expectAppended(second);
			expect(await all(log, path)).toEqual([{ a: 1 }, [1, 2], 'text', null, { b: 2 }]);
			// Resuming after the first append yields exactly the second: the
			// first append is one unit under one offset.
			expect(await log.read(path, first.nextOffset)).toMatchObject({
				messages: [{ b: 2 }],
				nextOffset: second.nextOffset,
				upToDate: true,
			});
		});

		it('mints unique offsets that strictly increase lexicographically', async () => {
			const { log, path, tail } = await fresh();
			const offsets: StreamOffset[] = [tail];
			for (let seq = 0; seq < 12; seq++) {
				const outcome = await log.append(path, {
					messages: [{ seq }],
					producer: producer('p', 0, seq),
				});
				expectAppended(outcome);
				offsets.push(outcome.nextOffset);
			}
			for (let index = 1; index < offsets.length; index++) {
				const previous = offsets[index - 1] as StreamOffset;
				const current = offsets[index] as StreamOffset;
				expect(compareOffsets(previous, current)).toBe(-1);
				expect(current).not.toBe(STREAM_START);
				expect(current).not.toBe(STREAM_NOW);
				expect(current).not.toMatch(/[,&=?/]/);
			}
			for (const [index, offset] of offsets.entries()) {
				const rest = await log.read(path, offset);
				expect(rest.messages).toEqual(
					Array.from({ length: offsets.length - 1 - index }, (_, n) => ({ seq: index + n })),
				);
			}
		});

		it('returns an empty up-to-date batch at the tail and for now', async () => {
			const { log, path } = await fresh();
			const outcome = await log.append(path, {
				messages: [{ n: 1 }],
				producer: producer('p', 0, 0),
			});
			expectAppended(outcome);
			expect(await log.read(path, outcome.nextOffset)).toMatchObject({
				messages: [],
				nextOffset: outcome.nextOffset,
				upToDate: true,
			});
			expect(await log.read(path, STREAM_NOW)).toMatchObject({
				messages: [],
				nextOffset: outcome.nextOffset,
				upToDate: true,
			});
		});

		it('deduplicates an in-epoch retry and any already-accepted seq', async () => {
			const { log, path } = await fresh();
			const first = await log.append(path, { messages: [1], producer: producer('p', 0, 0) });
			expectAppended(first);
			const retry = await log.append(path, { messages: [1], producer: producer('p', 0, 0) });
			expect(retry.status).toBe('duplicate');
			const second = await log.append(path, { messages: [2], producer: producer('p', 0, 1) });
			expectAppended(second);
			const older = await log.append(path, { messages: [1], producer: producer('p', 0, 0) });
			expect(older.status).toBe('duplicate');
			expect(await log.head(path)).toMatchObject({ nextOffset: second.nextOffset });
			expect(await all(log, path)).toEqual([1, 2]);
		});

		it('reports a producer gap with the expected seq and appends nothing', async () => {
			const { log, path, tail } = await fresh();
			expect(await log.append(path, { messages: [1], producer: producer('p', 0, 3) })).toEqual({
				status: 'producer-gap',
				expectedSeq: 0,
			});
			expect(await log.head(path)).toMatchObject({ nextOffset: tail });
			expectAppended(await log.append(path, { messages: [1], producer: producer('p', 0, 0) }));
			expect(await log.append(path, { messages: [3], producer: producer('p', 0, 2) })).toEqual({
				status: 'producer-gap',
				expectedSeq: 1,
			});
			expectAppended(await log.append(path, { messages: [2], producer: producer('p', 0, 1) }));
			expect(await all(log, path)).toEqual([1, 2]);
		});

		it('fences a stale epoch with the current epoch', async () => {
			const { log, path } = await fresh();
			expectAppended(await log.append(path, { messages: [1], producer: producer('p', 0, 0) }));
			expectAppended(await log.append(path, { messages: [2], producer: producer('p', 1, 0) }));
			const head = await log.head(path);
			expect(await log.append(path, { messages: [3], producer: producer('p', 0, 1) })).toEqual({
				status: 'fenced',
				currentEpoch: 1,
			});
			expect(await log.head(path)).toEqual(head);
			// The new epoch continues from its own seq 0.
			expectAppended(await log.append(path, { messages: [3], producer: producer('p', 1, 1) }));
			expect(await all(log, path)).toEqual([1, 2, 3]);
		});

		it('rejects a higher epoch that does not start at seq 0', async () => {
			const { log, path } = await fresh();
			expectAppended(await log.append(path, { messages: [1], producer: producer('p', 0, 0) }));
			await expect(
				log.append(path, { messages: [2], producer: producer('p', 1, 2) }),
			).rejects.toMatchObject({ code: 'bad-request' });
			expect(await all(log, path)).toEqual([1]);
		});

		it('keeps separate seq spaces per producer id', async () => {
			const { log, path } = await fresh();
			expectAppended(await log.append(path, { messages: ['p0'], producer: producer('p', 0, 0) }));
			expectAppended(await log.append(path, { messages: ['q0'], producer: producer('q', 0, 0) }));
			expectAppended(await log.append(path, { messages: ['p1'], producer: producer('p', 0, 1) }));
			expect(await all(log, path)).toEqual(['p0', 'q0', 'p1']);
		});

		it('rejects a Stream-Seq regression per stream, across producers', async () => {
			const { log, path } = await fresh();
			const first = await log.append(path, {
				messages: [1],
				producer: producer('p', 0, 0),
				streamSeq: '0000000000000002',
			});
			expectAppended(first);
			for (const streamSeq of ['0000000000000002', '0000000000000001']) {
				const conflict = await log.append(path, {
					messages: ['x'],
					producer: producer('p', 0, 1),
					streamSeq,
				});
				expect(conflict.status).toBe('stream-seq-conflict');
			}
			// Stream-Seq is scoped to the stream: another producer id conflicts too.
			const other = await log.append(path, {
				messages: ['y'],
				producer: producer('q', 0, 0),
				streamSeq: '0000000000000001',
			});
			expect(other.status).toBe('stream-seq-conflict');
			// Byte-wise lexicographic: "10" < "9".
			expectAppended(
				await log.append(path, { messages: [2], producer: producer('p', 0, 1), streamSeq: '9' }),
			);
			expect(
				(
					await log.append(path, {
						messages: ['z'],
						producer: producer('p', 0, 2),
						streamSeq: '10',
					})
				).status,
			).toBe('stream-seq-conflict');
			expect(await all(log, path)).toEqual([1, 2]);
		});

		it('checks Stream-Seq after producer dedup, so a retry stays a duplicate', async () => {
			const { log, path } = await fresh();
			const input = {
				messages: [1],
				producer: producer('p', 0, 0),
				streamSeq: '0000000000000001',
			};
			expectAppended(await log.append(path, input));
			expect((await log.append(path, input)).status).toBe('duplicate');
			expect(await all(log, path)).toEqual([1]);
		});

		it('fences a replay after an epoch bump by Stream-Seq without consuming the producer seq', async () => {
			// The drain protocol (PI_UPGRADE_PLAN §2.4): a commit that landed
			// under epoch 0 and is replayed under epoch 1 is a
			// stream-seq-conflict, and the reference servers commit producer
			// state only after the Stream-Seq check — so the next commit still
			// starts epoch 1 at seq 0.
			const { log, path } = await fresh();
			expectAppended(
				await log.append(path, {
					messages: ['c1'],
					producer: producer('p', 0, 0),
					streamSeq: '0000000000000001',
				}),
			);
			const replay = await log.append(path, {
				messages: ['c1'],
				producer: producer('p', 1, 0),
				streamSeq: '0000000000000001',
			});
			expect(replay.status).toBe('stream-seq-conflict');
			expectAppended(
				await log.append(path, {
					messages: ['c2'],
					producer: producer('p', 1, 0),
					streamSeq: '0000000000000002',
				}),
			);
			expectAppended(
				await log.append(path, {
					messages: ['c3'],
					producer: producer('p', 1, 1),
					streamSeq: '0000000000000003',
				}),
			);
			expect(await all(log, path)).toEqual(['c1', 'c2', 'c3']);
		});

		it('rejects malformed appends and appends to a missing stream', async () => {
			const { log, path } = await fresh();
			await expect(
				log.append(path, { messages: [], producer: producer('p', 0, 0) }),
			).rejects.toBeInstanceOf(DurableStreamLogError);
			await expect(
				log.append(path, { messages: [1], producer: producer('', 0, 0) }),
			).rejects.toMatchObject({ code: 'bad-request' });
			await expect(
				log.append(path, { messages: [1], producer: producer('p', -1, 0) }),
			).rejects.toMatchObject({ code: 'bad-request' });
			await expect(
				log.append(freshPath(), { messages: [1], producer: producer('p', 0, 0) }),
			).rejects.toMatchObject({ code: 'not-found' });
			await expect(log.read(freshPath(), STREAM_START)).rejects.toMatchObject({
				code: 'not-found',
			});
			expect(await all(log, path)).toEqual([]);
		});

		it.skipIf(backend.liveWakes === false)(
			'wakes a long-poll parked at the tail on append',
			async () => {
				const { log, path, tail } = await fresh();
				const pending = log.read(path, tail, { live: 'long-poll' });
				await new Promise((resolve) => setTimeout(resolve, 50));
				const appended = await log.append(path, {
					messages: [{ live: true }],
					producer: producer('p', 0, 0),
				});
				expectAppended(appended);
				const batch = await pending;
				expect(batch.messages).toEqual([{ live: true }]);
				expect(batch.nextOffset).toBe(appended.nextOffset);
				expect(typeof batch.cursor).toBe('string');
			},
		);

		it('returns catch-up data to a long-poll immediately', async () => {
			const { log, path, tail } = await fresh();
			expectAppended(await log.append(path, { messages: [1], producer: producer('p', 0, 0) }));
			const batch = await log.read(path, tail, { live: 'long-poll' });
			expect(batch.messages).toEqual([1]);
		});

		it('stops a parked long-poll on abort', async () => {
			const { log, path, tail } = await fresh();
			const controller = new AbortController();
			const pending = log.read(path, tail, { live: 'long-poll', signal: controller.signal });
			await new Promise((resolve) => setTimeout(resolve, 20));
			controller.abort();
			await expect(pending).rejects.toBeDefined();
		});
	});
}
