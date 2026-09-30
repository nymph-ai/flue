import type { StorageWrite } from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import {
	CommitAssembler,
	commitMessages,
	createCommitEnvelope,
	decodeCommitEnvelope,
	decodeLogMessage,
	encodeCommitEnvelope,
	PiCommitEnvelopeError,
	sameCommit,
	streamSeqFor,
} from './commit-envelope.ts';
import { recordedBatches } from './stream-storage-test-support.ts';

const base = { storage: '01JTESTINCARNATION', epoch: 0, at: 1_700_000_000_000 };

/** What the SQLite index keeps of a value: JSON, with undefined properties dropped. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('Pi commit envelope', () => {
	it('round-trips every write of a real Harness session exactly', async () => {
		const batches = await recordedBatches();
		const types = new Set<string>();
		let deltas = 0;
		for (const [index, writes] of batches.entries()) {
			const envelope = createCommitEnvelope({ ...base, seq: index + 1, writes });
			const decoded = decodeCommitEnvelope(encodeCommitEnvelope(envelope));
			expect(decoded.writes).toStrictEqual(asJson(writes));
			expect(decoded).toStrictEqual(asJson(envelope));
			// Re-encoding the decoded form is byte-identical: nothing drifts across hops.
			expect(encodeCommitEnvelope(decoded)).toBe(encodeCommitEnvelope(envelope));
			for (const write of writes) {
				types.add(write.type);
				if (write.type === 'document.change' && write.content.kind === 'delta') deltas++;
			}
		}
		// The session exercises the record tables, document creation and Chord deltas.
		for (const type of ['conversation', 'entry', 'task', 'submission', 'document.create', 'document.change']) {
			expect([...types]).toContain(type);
		}
		expect(deltas).toBeGreaterThan(0);
	});

	it('round-trips every StorageWrite variant, including delta ops and awkward strings', () => {
		const writes = [
			{ type: 'conversation', value: { id: 1, owner: undefined } },
			{
				type: 'entry',
				value: {
					id: 2,
					conversationId: 1,
					kind: 'note',
					data: JSON.parse('{"__proto__":{"x":1},"s":"\\ud800 lone","e":"😀 \\" \\\\ \\n","n":-1.5e-7}'),
				},
			},
			{ type: 'task', value: { id: 3, conversationId: 1, kind: 'k', state: { status: 'pending' } } },
			{ type: 'submission', value: { id: 4, conversationId: 1, type: 'input', status: 'queued', requestId: 'r' } },
			{
				type: 'document.create',
				record: { id: 5, kind: 'd', scope: { kind: 'session' } },
				content: { kind: 'base', version: 1, value: { list: [1, 'two', null, { three: true }] } },
			},
			{ type: 'document.copy', record: { id: 6, kind: 'd', scope: { kind: 'session' } }, source: { id: 5, at: 2 } },
			{
				type: 'document.change',
				id: 5,
				content: {
					kind: 'delta',
					version: 1,
					ops: [
						['s', ['list', 0], 9],
						['a', ['text'], 'more'],
						['p', ['list'], 1, 1, ['x', 'y']],
						['m', ['list'], [1, 0, 2]],
						['t', ['count'], 3],
						['d', ['gone']],
					],
				},
			},
			{ type: 'document.change', id: 5, content: { kind: 'base', version: 2, value: { reset: true } } },
			{ type: 'document.retire', id: 6 },
		] as unknown as StorageWrite[];
		const envelope = createCommitEnvelope({ ...base, seq: 7, writes });
		const decoded = decodeCommitEnvelope(encodeCommitEnvelope(envelope));
		expect(decoded.writes).toStrictEqual(asJson(writes));
		const entry = decoded.writes[1] as { value: { data: Record<string, unknown> } };
		expect(Object.hasOwn(entry.value.data, '__proto__')).toBe(true);
		expect(entry.value.data.s).toBe('\ud800 lone');
		expect(sameCommit(envelope, decoded)).toBe(true);
	});

	it('rejects values JSON would change rather than publish them', () => {
		const entry = (data: unknown) =>
			[{ type: 'entry', value: { id: 2, conversationId: 1, kind: 'x', data } }] as unknown as StorageWrite[];
		for (const data of [Number.NaN, Number.POSITIVE_INFINITY, [1, undefined], new Date(0), new Map(), 1n]) {
			expect(() => createCommitEnvelope({ ...base, seq: 1, writes: entry(data) })).toThrow(PiCommitEnvelopeError);
		}
		expect(() =>
			createCommitEnvelope({ ...base, seq: 1, writes: [{ type: 'nope' }] as unknown as StorageWrite[] }),
		).toThrow(/unknown storage write type/);
		expect(() => decodeCommitEnvelope({ v: 2, type: 'pi.commit' })).toThrow(PiCommitEnvelopeError);
		expect(() => decodeLogMessage({ type: 'something-else' })).toThrow(PiCommitEnvelopeError);
	});

	it('splits a large envelope into parts that reassemble exactly, inside one POST', () => {
		const text = `${'ünïcødé 😀 "quoted" \\ '.repeat(400)}\ud800`;
		const writes = [
			{ type: 'entry', value: { id: 2, conversationId: 1, kind: 'big', data: { text } } },
		] as unknown as StorageWrite[];
		const envelope = createCommitEnvelope({ ...base, seq: 3, writes });
		const body = encodeCommitEnvelope(envelope);
		const messages = commitMessages(body, 1024);
		expect(messages.length).toBeGreaterThan(5);
		for (const message of messages) {
			expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(1024);
		}
		const assembler = new CommitAssembler();
		const assembled = messages.map((message) => assembler.accept(message));
		expect(assembled.slice(0, -1).every((value) => value === undefined)).toBe(true);
		expect(assembled.at(-1)).toStrictEqual(asJson(envelope));
		expect(assembler.pending).toBe(false);
		// Under the limit, the envelope travels as itself.
		expect(commitMessages(body, body.length * 4)).toStrictEqual([asJson(envelope)]);
	});

	it('refuses parts out of order or interrupted', () => {
		const writes = [
			{ type: 'entry', value: { id: 2, conversationId: 1, kind: 'big', data: 'x'.repeat(4000) } },
		] as unknown as StorageWrite[];
		const messages = commitMessages(encodeCommitEnvelope(createCommitEnvelope({ ...base, seq: 1, writes })), 1024);
		expect(() => new CommitAssembler().accept(messages[1])).toThrow(/out of order/);
		const interrupted = new CommitAssembler();
		interrupted.accept(messages[0]);
		expect(() => interrupted.accept(createCommitEnvelope({ ...base, seq: 2, writes: [] }))).toThrow(/missing parts/);
	});

	it('pads Stream-Seq so byte order is numeric order', () => {
		expect(streamSeqFor(9) < streamSeqFor(10)).toBe(true);
		expect(streamSeqFor(1)).toBe('0000000000000001');
	});
});
