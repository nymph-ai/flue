/**
 * Contract suite for {@link DurableStreamLog} implementations: plain appends,
 * JSON-mode atomicity and flattening (PROTOCOL.md §9.1), and opaque,
 * lexicographically ordered offsets (§8) — what the entity layer needs of its
 * inbox and events streams.
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
import { type DurableStreamLog, DurableStreamLogError } from '../streams/log.ts';
import { compareOffsets, STREAM_NOW, STREAM_START, type StreamOffset } from '../streams/offset.ts';

export interface DurableStreamLogContractBackend {
	create(): DurableStreamLog | Promise<DurableStreamLog>;
	cleanup?(): void | Promise<void>;
	/** Prepended to every stream path (default `"contract/"`). */
	pathPrefix?: string;
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

		it('appends and advances the tail', async () => {
			const { log, path, tail } = await fresh();
			const outcome = await log.append(path, [{ n: 1 }]);
			expect(compareOffsets(outcome.nextOffset, tail)).toBe(1);
			expect(await log.head(path)).toEqual({ nextOffset: outcome.nextOffset, closed: false });
			expect(await all(log, path)).toEqual([{ n: 1 }]);
		});

		it('keeps one append atomic and flattens exactly one array level', async () => {
			const { log, path } = await fresh();
			const first = await log.append(path, [{ a: 1 }, [1, 2], 'text', null]);
			const second = await log.append(path, [{ b: 2 }]);
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
				const outcome = await log.append(path, [{ seq }]);
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

		it('returns an empty up-to-date batch at the tail', async () => {
			const { log, path } = await fresh();
			const outcome = await log.append(path, [{ n: 1 }]);
			expect(await log.read(path, outcome.nextOffset)).toMatchObject({
				messages: [],
				nextOffset: outcome.nextOffset,
				upToDate: true,
			});
		});

		it("appends a repeated message again: deduplication is the receiver's", async () => {
			const { log, path } = await fresh();
			await log.append(path, [{ id: 'e1' }]);
			await log.append(path, [{ id: 'e1' }]);
			expect(await all(log, path)).toEqual([{ id: 'e1' }, { id: 'e1' }]);
		});

		it('rejects malformed appends and appends to a missing stream', async () => {
			const { log, path } = await fresh();
			await expect(log.append(path, [])).rejects.toBeInstanceOf(DurableStreamLogError);
			await expect(log.append(freshPath(), [1])).rejects.toMatchObject({ code: 'not-found' });
			await expect(log.read(freshPath(), STREAM_START)).rejects.toMatchObject({
				code: 'not-found',
			});
			expect(await all(log, path)).toEqual([]);
		});
	});
}
