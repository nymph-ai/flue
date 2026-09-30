/**
 * The Durable Streams write fences (PROTOCOL.md §5.2 `Stream-Seq`, §5.2.1
 * idempotent producers), as pure functions over per-stream state. Shared by
 * the logs that enforce the protocol themselves (`memory-log.ts`,
 * `store-bridge-log.ts`); the HTTP log leaves enforcement to the server.
 *
 * Mirrors the reference servers exactly — `validateProducer` in
 * durable-streams `packages/server/src/store.ts` and `validate_producer` in
 * `durable-streams-rust/src/handlers.rs` — including the order of checks:
 * producer validation first, then `Stream-Seq`, and state committed only once
 * both pass.
 */

import { DurableStreamLogError, type ProducerClaim } from './log.ts';

export interface ProducerState {
	readonly epoch: number;
	readonly lastSeq: number;
}

export type ProducerDecision =
	| { readonly kind: 'accept'; readonly next: ProducerState }
	| { readonly kind: 'duplicate'; readonly lastSeq: number }
	| { readonly kind: 'fenced'; readonly currentEpoch: number }
	| { readonly kind: 'gap'; readonly expectedSeq: number };

/** Reject a malformed claim the way a server answers 400 (§5.2.1 "Request Headers"). */
export function assertProducerClaim(path: string, claim: ProducerClaim): void {
	if (typeof claim.id !== 'string' || claim.id.length === 0) {
		throw new DurableStreamLogError({
			code: 'bad-request',
			path,
			message: 'Producer-Id must be a non-empty string.',
			status: 400,
		});
	}
	for (const [name, value] of [
		['Producer-Epoch', claim.epoch],
		['Producer-Seq', claim.seq],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new DurableStreamLogError({
				code: 'bad-request',
				path,
				message: `${name} must be a non-negative integer ≤ 2^53-1, got ${value}.`,
				status: 400,
			});
		}
	}
}

/**
 * §5.2.1 "Validation Logic". A new epoch that does not start at seq 0 is a
 * 400 on every reference server and throws here.
 */
export function validateProducer(
	path: string,
	state: ProducerState | undefined,
	claim: ProducerClaim,
): ProducerDecision {
	if (!state) {
		return claim.seq === 0
			? { kind: 'accept', next: { epoch: claim.epoch, lastSeq: 0 } }
			: { kind: 'gap', expectedSeq: 0 };
	}
	if (claim.epoch < state.epoch) return { kind: 'fenced', currentEpoch: state.epoch };
	if (claim.epoch > state.epoch) {
		if (claim.seq !== 0) {
			throw new DurableStreamLogError({
				code: 'bad-request',
				path,
				message: `New producer epoch ${claim.epoch} must start at seq 0, got ${claim.seq}.`,
				status: 400,
			});
		}
		return { kind: 'accept', next: { epoch: claim.epoch, lastSeq: 0 } };
	}
	if (claim.seq <= state.lastSeq) return { kind: 'duplicate', lastSeq: state.lastSeq };
	if (claim.seq === state.lastSeq + 1) {
		return { kind: 'accept', next: { epoch: claim.epoch, lastSeq: claim.seq } };
	}
	return { kind: 'gap', expectedSeq: state.lastSeq + 1 };
}

/**
 * §5.2 `Stream-Seq`: strictly increasing under byte-wise lexicographic order.
 * `true` when `next` may be accepted after `last`.
 */
export function streamSeqAdvances(last: string | undefined, next: string | undefined): boolean {
	if (next === undefined || last === undefined) return true;
	return next > last;
}

/** Messages as the JSON the stream stores; rejects what `application/json` cannot carry. */
export function serializeMessages(path: string, messages: readonly unknown[]): string {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new DurableStreamLogError({
			code: 'bad-request',
			path,
			message: 'An append must carry at least one message (PROTOCOL §9.1.3).',
			status: 400,
		});
	}
	let data: string | undefined;
	try {
		data = JSON.stringify(messages);
	} catch (cause) {
		throw new DurableStreamLogError({
			code: 'bad-request',
			path,
			message: 'Messages are not valid JSON.',
			status: 400,
			cause,
		});
	}
	// `undefined` elements serialize as `null`; a top-level undefined or a
	// function cannot reach here through the array form.
	if (data === undefined) {
		throw new DurableStreamLogError({
			code: 'bad-request',
			path,
			message: 'Messages are not valid JSON.',
			status: 400,
		});
	}
	return data;
}
