/**
 * Step 2 of PI_UPGRADE_PLAN.md: the runtime treats conversation-stream offsets
 * as opaque. These tests run the store contract, the HTTP read routes, the
 * shared fold host and the in-process observer against stores whose offsets
 * are NOT the `formatOffset` shape — an Electric-style `<segment>_<bytes>`
 * token with a non-zero segment, and a token with a random per-stream prefix —
 * so any leftover integer parsing in the runtime core fails here.
 */
import { describe, expect, it } from 'vitest';
import { getConversationFoldHost } from '../conversation-fold-host.ts';
import type { ConversationStreamChunk } from '../conversation-public.ts';
import { loadReducedConversationState } from '../conversation-reader.ts';
import type { ConversationRecord } from '../conversation-records.ts';
import { createReducedInstanceState } from '../conversation-reducer.ts';
import {
	type ConversationFoldCheckpoint,
	type ConversationProducerClaim,
	type ConversationStreamIdentity,
	type ConversationStreamMeta,
	type ConversationStreamReadResult,
	type ConversationStreamStore,
	InMemoryConversationStreamStore,
} from '../runtime/conversation-stream-store.ts';
import {
	observeSubmissionSettlement,
	projectConversationRead,
} from '../runtime/conversation-observer.ts';
import { handleAgentConversationRead } from '../runtime/handle-conversation-routes.ts';
import { parseOffset } from '../runtime/stream-offsets.ts';
import { defineConversationStreamStoreContractTests } from '../test-utils/define-conversation-stream-store-contract-tests.ts';
import { compareOffsets, isResumeOffset, STREAM_NOW, STREAM_START } from './offset.ts';

type Mint = (path: string, position: number) => string;

/** Electric-style: `<segment>_<byte offset>`, a non-zero segment so no legacy decoding applies. */
const electricStyle: Mint = (_path, position) =>
	`${String(1).padStart(16, '0')}_${String((position + 1) * 123).padStart(16, '0')}`;

/** A random prefix per stream, then a fixed-width base-36 counter. */
function randomPrefixStyle(): Mint {
	const prefixes = new Map<string, string>();
	return (path, position) => {
		let prefix = prefixes.get(path);
		if (!prefix) {
			prefix = `s${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
			prefixes.set(path, prefix);
		}
		return `${prefix}.${position.toString(36).padStart(10, '0')}`;
	};
}

/**
 * A conversation store whose offsets are opaque, non-numeric tokens. It is a
 * store, so it may decode its own inner offsets (that is exactly what
 * `parseOffset` is kept for); the runtime above it must not. Ordinals are
 * deliberately offset from the inner sequence so they cannot be confused with
 * anything derived from an offset.
 */
class OpaqueOffsetConversationStreamStore implements ConversationStreamStore {
	private readonly inner = new InMemoryConversationStreamStore();
	private readonly toInner = new Map<string, Map<string, string>>();

	constructor(private readonly mint: Mint) {}

	private opaque(path: string, innerOffset: string): string {
		if (innerOffset === '-1') return innerOffset;
		const offset = this.mint(path, parseOffset(innerOffset));
		let known = this.toInner.get(path);
		if (!known) {
			known = new Map();
			this.toInner.set(path, known);
		}
		known.set(offset, innerOffset);
		return offset;
	}

	private innerOf(path: string, offset: string): string {
		if (offset === '-1' || offset === 'now') return offset;
		const inner = this.toInner.get(path)?.get(offset);
		if (inner === undefined) throw new Error(`Unknown offset "${offset}" for ${path}.`);
		return inner;
	}

	createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
		return this.inner.createStream(path, identity);
	}

	async acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim> {
		const claim = await this.inner.acquireProducer(path, producerId);
		return { ...claim, offset: this.opaque(path, claim.offset) };
	}

	async append(input: Parameters<ConversationStreamStore['append']>[0]) {
		const result = await this.inner.append(input);
		return { offset: this.opaque(input.path, result.offset) };
	}

	async read(
		path: string,
		options?: { offset?: string; limit?: number },
	): Promise<ConversationStreamReadResult> {
		const result = await this.inner.read(path, {
			...options,
			...(options?.offset === undefined ? {} : { offset: this.innerOf(path, options.offset) }),
		});
		return {
			batches: result.batches.map((batch) => ({
				offset: this.opaque(path, batch.offset),
				records: batch.records,
				ordinal: 1_000 + 7 * parseOffset(batch.offset),
			})),
			nextOffset: this.opaque(path, result.nextOffset),
			upToDate: result.upToDate,
		};
	}

	async getMeta(path: string): Promise<ConversationStreamMeta | null> {
		const meta = await this.inner.getMeta(path);
		return meta ? { ...meta, nextOffset: this.opaque(path, meta.nextOffset) } : null;
	}

	subscribe(path: string, listener: () => void): () => void {
		return this.inner.subscribe(path, listener);
	}

	putFoldCheckpoint(path: string, checkpoint: ConversationFoldCheckpoint): Promise<void> {
		return this.inner.putFoldCheckpoint(path, {
			...checkpoint,
			offset: this.innerOf(path, checkpoint.offset),
		});
	}

	async getFoldCheckpoint(
		path: string,
		options?: { atOrBefore?: string },
	): Promise<ConversationFoldCheckpoint | null> {
		const checkpoint = await this.inner.getFoldCheckpoint(
			path,
			options?.atOrBefore === undefined
				? undefined
				: { atOrBefore: this.innerOf(path, options.atOrBefore) },
		);
		return checkpoint ? { ...checkpoint, offset: this.opaque(path, checkpoint.offset) } : null;
	}
}

const variants: [string, () => Mint][] = [
	['Electric-style offsets', () => electricStyle],
	['random-prefix offsets', randomPrefixStyle],
];

for (const [label, mint] of variants) {
	defineConversationStreamStoreContractTests(`opaque store contract (${label})`, {
		create: () => ({ stream: new OpaqueOffsetConversationStreamStore(mint()) }),
	});
}

defineConversationStreamStoreContractTests('InMemoryConversationStreamStore contract', {
	create: () => ({ stream: new InMemoryConversationStreamStore() }),
});

describe('offset helpers', () => {
	it('orders the start sentinel before every minted offset', () => {
		expect(compareOffsets(STREAM_START, '0000000000000000_0000000000000000')).toBe(-1);
		expect(compareOffsets('!', STREAM_START)).toBe(1);
		expect(compareOffsets(STREAM_START, STREAM_START)).toBe(0);
		expect(compareOffsets('a', 'b')).toBe(-1);
		expect(compareOffsets('b', 'a')).toBe(1);
		// Lexicographic, not numeric.
		expect(compareOffsets('10', '9')).toBe(-1);
	});

	it('validates resume offsets per PROTOCOL §8', () => {
		expect(isResumeOffset('-1')).toBe(true);
		expect(isResumeOffset('0000000000000001_0000000000000123')).toBe(true);
		expect(isResumeOffset('sAbC.00000000z1')).toBe(true);
		expect(isResumeOffset(STREAM_NOW)).toBe(false);
		expect(isResumeOffset('')).toBe(false);
		for (const bad of ['a,b', 'a&b', 'a=b', 'a?b', 'a/b', 'a b', 'a\nb']) {
			expect(isResumeOffset(bad)).toBe(false);
		}
	});
});

// ─── Runtime core over opaque offsets ───────────────────────────────────────

const path = 'agents/echo/opaque';
const timestamp = '2026-01-01T00:00:00.000Z';

function envelope(id: string, submissionId?: string) {
	return {
		v: 1 as const,
		id,
		conversationId: 'conv_opaque',
		harness: 'default',
		session: 'default',
		timestamp,
		...(submissionId ? { submissionId, attemptId: `att_${submissionId}` } : {}),
	};
}

const created: ConversationRecord = {
	...envelope('record_created'),
	type: 'conversation_created',
	kind: 'root',
	affinityKey: 'affinity_opaque',
	createdAt: timestamp,
};

function userMessage(id: string, parentId: string | null, submissionId?: string): ConversationRecord {
	return {
		...envelope(`record_${id}`, submissionId),
		type: 'user_message',
		messageId: id,
		parentId,
		content: [{ type: 'text', text: id }],
	};
}

function settled(submissionId: string): ConversationRecord {
	return {
		...envelope(`record_settled_${submissionId}`, submissionId),
		type: 'submission_settled',
		submissionId,
		outcome: 'completed',
	};
}

async function createConversation(store: ConversationStreamStore) {
	await store.createStream(path, { agentName: 'echo', instanceId: 'opaque' });
	const producer = await store.acquireProducer(path, 'coordinator');
	let sequence = 0;
	const append = async (records: ConversationRecord[]) => {
		const submissionId = records[0]?.submissionId;
		return store.append({
			path,
			producerId: producer.producerId,
			producerEpoch: producer.producerEpoch,
			incarnation: producer.incarnation,
			producerSequence: sequence++,
			...(submissionId ? { submission: { submissionId, attemptId: `att_${submissionId}` } } : {}),
			records,
		});
	};
	return { append };
}

async function get(store: ConversationStreamStore, query: string, signal?: AbortSignal) {
	const response = await handleAgentConversationRead({
		store,
		path,
		request: new Request(`https://flue.test/agents/echo/opaque?${query}`, signal ? { signal } : {}),
	});
	const text = await response.text();
	return {
		status: response.status,
		headers: response.headers,
		body: text ? (JSON.parse(text) as unknown) : undefined,
	};
}

const q = (value: string) => encodeURIComponent(value);

for (const [label, mint] of variants) {
	describe(`runtime core over ${label}`, () => {
		it('serves history and updates with the store-minted opaque offsets', async () => {
			const store = new OpaqueOffsetConversationStreamStore(mint());
			const { append } = await createConversation(store);
			await append([created]);
			const second = await append([userMessage('entry_m0', null)]);

			const history = await get(store, 'view=history');
			expect(history.status).toBe(200);
			const body = history.body as { offset: string; messages: { id: string }[] };
			expect(body.offset).toBe(second.offset);
			expect(history.headers.get('Stream-Next-Offset')).toBe(second.offset);
			expect(body.messages.map((message) => message.id)).toEqual(['entry_m0']);

			const third = await append([userMessage('entry_m1', 'entry_m0')]);
			const updates = await get(store, `view=updates&offset=${q(body.offset)}`);
			expect(updates.status).toBe(200);
			expect(updates.headers.get('Stream-Next-Offset')).toBe(third.offset);
			const chunks = updates.body as ConversationStreamChunk[];
			expect(chunks[0]).toMatchObject({ type: 'stream-checkpoint' });
			const appended = chunks.filter((chunk) => chunk.type === 'message-appended');
			expect(appended).toHaveLength(1);
			// position.batch is the store-supplied ordinal, never parsed from the offset.
			expect(appended[0]?.position.batch).toBe(1_000 + 7 * 2);

			// A lagging resume offset replays its prefix from the store.
			const lagging = await get(store, `view=updates&offset=-1`);
			const lagChunks = (lagging.body as ConversationStreamChunk[]).filter(
				(chunk) => chunk.type === 'message-appended',
			);
			expect(lagChunks.map((chunk) => chunk.position.batch)).toEqual([1_007, 1_014]);

			// Caught up: an empty, up-to-date page at the same offset.
			const head = await get(store, `view=updates&offset=${q(third.offset)}`);
			expect(head.status).toBe(200);
			expect(head.headers.get('Stream-Next-Offset')).toBe(third.offset);
			expect(head.headers.get('Stream-Up-To-Date')).toBe('true');
		});

		it('rejects a resume offset beyond the head by lexicographic order', async () => {
			const store = new OpaqueOffsetConversationStreamStore(mint());
			const { append } = await createConversation(store);
			const { offset } = await append([created]);
			const beyond = `${offset}~`;
			expect(compareOffsets(beyond, offset)).toBe(1);
			const response = await get(store, `view=updates&offset=${q(beyond)}`);
			expect(response.status).toBe(416);
			const malformed = await get(store, `view=updates&offset=${q('a/b')}`);
			expect(malformed.status).toBe(400);
		});

		it('wakes a long-poll reader on a new batch', async () => {
			const store = new OpaqueOffsetConversationStreamStore(mint());
			const { append } = await createConversation(store);
			await append([created]);
			const { offset } = await append([userMessage('entry_m0', null)]);
			const pending = get(store, `view=updates&offset=${q(offset)}&live=long-poll`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const next = await append([userMessage('entry_m1', 'entry_m0')]);
			const response = await pending;
			expect(response.status).toBe(200);
			expect(response.headers.get('Stream-Next-Offset')).toBe(next.offset);
			expect(
				(response.body as ConversationStreamChunk[]).some(
					(chunk) => chunk.type === 'message-appended',
				),
			).toBe(true);
		});

		it('advances the shared fold host and orders adopted states by opaque offset', async () => {
			const store = new OpaqueOffsetConversationStreamStore(mint());
			const { append } = await createConversation(store);
			const first = await append([created]);
			const host = getConversationFoldHost(store, path);
			const atFirst = await host.getStateAtHead();
			expect(atFirst.recordsThroughOffset).toBe(first.offset);

			const second = await append([userMessage('entry_m0', null)]);
			const atSecond = await host.getStateAtHead();
			expect(atSecond.recordsThroughOffset).toBe(second.offset);

			// An older state never replaces a newer one.
			const meta = await store.getMeta(path);
			host.adoptState(atFirst, meta?.incarnation ?? '');
			expect((await host.getStateAtHead()).recordsThroughOffset).toBe(second.offset);

			// Fold checkpoints are bounded by lexicographic offset order.
			await store.putFoldCheckpoint(path, {
				offset: second.offset,
				incarnation: meta?.incarnation ?? '',
				formatVersion: 1,
				data: '{}',
			});
			expect(await store.getFoldCheckpoint(path, { atOrBefore: first.offset })).toBeNull();
			const loaded = await loadReducedConversationState({ store, path });
			expect(loaded.recordsThroughOffset).toBe(second.offset);
		});

		it('observes a submission settlement and projects ordinals', async () => {
			const store = new OpaqueOffsetConversationStreamStore(mint());
			const { append } = await createConversation(store);
			await append([created]);
			const { offset } = await append([userMessage('entry_m0', null, 'sub_1')]);
			const events: ConversationStreamChunk[] = [];
			const settlement = observeSubmissionSettlement({
				store,
				path,
				submissionId: 'sub_1',
				offset,
				onEvent: (chunk) => events.push(chunk),
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			await append([settled('sub_1')]);
			await expect(settlement).resolves.toEqual({ outcome: 'completed' });
			expect(events.at(-1)).toMatchObject({
				type: 'submission-settled',
				position: { batch: 1_000 + 7 * 2, index: 0 },
			});

			// The projection helper also stamps store ordinals.
			const read = await store.read(path);
			const projected = projectConversationRead(createReducedInstanceState(), read);
			expect(projected.offset).toBe(read.nextOffset);
			expect(projected.items.length).toBeGreaterThan(0);
			for (const chunk of projected.items) {
				expect([1_000, 1_007, 1_014]).toContain(chunk.position.batch);
			}
			expect(projected.items.at(-1)?.position.batch).toBe(1_014);
		});
	});
}

describe('stores without ordinals', () => {
	it('fails loudly when an opaque offset carries no ordinal', async () => {
		const opaque = new OpaqueOffsetConversationStreamStore(electricStyle);
		const { append } = await createConversation(opaque);
		await append([created]);
		const read = await opaque.read(path);
		const stripped = {
			...read,
			batches: read.batches.map(({ ordinal: _ordinal, ...batch }) => batch),
		};
		expect(() => projectConversationRead(createReducedInstanceState(), stripped)).toThrow(
			/carries no ordinal/,
		);
	});
});
