/**
 * Durable Streams offsets (PROTOCOL.md §8).
 *
 * An offset is an opaque, case-sensitive token minted by the store or server
 * that owns the stream. The runtime never interprets its structure: it only
 * echoes offsets back, tests them for equality, and orders them with
 * {@link compareOffsets} — the byte-wise lexicographic comparison §8(2)
 * guarantees for any two offsets of the same stream.
 *
 * Stores that mint their own integer-backed offsets (the SQL, Redis and
 * MongoDB stores) keep `formatOffset`/`parseOffset` from
 * `runtime/stream-offsets.ts` as a private encoding. Nothing outside a store
 * may parse an offset.
 */

declare const offsetBrand: unique symbol;

/** Opaque Durable Streams offset; only compare with {@link compareOffsets}. */
export type StreamOffset = string & { readonly [offsetBrand]: true };

/** Sentinel: the beginning of the stream (§8, "Stream Beginning"). */
export const STREAM_START = '-1' as StreamOffset;

/** Sentinel: the current tail; only valid as a read position (§8, "Current Tail Position"). */
export const STREAM_NOW = 'now' as StreamOffset;

/**
 * Order two offsets of the same stream (§8(2)): `STREAM_START` precedes every
 * minted offset, everything else compares byte-wise lexicographically. Code
 * unit comparison equals byte-wise comparison for the URL-safe ASCII tokens
 * the protocol recommends, and it is the comparison every reference server
 * uses (`a < b` in the Node server, `str <=` in the Rust server).
 *
 * `STREAM_NOW` is a request sentinel, never a position, and must be resolved
 * to a real offset before it is compared.
 */
export function compareOffsets(a: string, b: string): number {
	if (a === b) return 0;
	if (a === STREAM_START) return -1;
	if (b === STREAM_START) return 1;
	return a < b ? -1 : 1;
}

/** Characters §8 forbids inside an offset token (URL query syntax). */
const FORBIDDEN_OFFSET_CHARACTERS = /[,&=?/]/;

/** §8 recommends offsets stay under 256 characters; reject anything absurd. */
const MAX_OFFSET_LENGTH = 1024;

/**
 * Whether a caller-supplied string is a syntactically valid resume offset:
 * the `-1` sentinel or a non-empty token without the characters §8 reserves.
 * The `now` sentinel is not a resume position and is rejected here; callers
 * that accept it check for it explicitly.
 */
export function isResumeOffset(value: string): value is StreamOffset {
	if (value === STREAM_START) return true;
	if (value === STREAM_NOW) return false;
	return (
		value.length > 0 &&
		value.length <= MAX_OFFSET_LENGTH &&
		!FORBIDDEN_OFFSET_CHARACTERS.test(value) &&
		// Control characters and whitespace never appear in a minted token.
		!/[\s\p{Cc}]/u.test(value)
	);
}

/** Brand a store- or server-minted offset string. */
export function asStreamOffset(value: string): StreamOffset {
	return value as StreamOffset;
}
