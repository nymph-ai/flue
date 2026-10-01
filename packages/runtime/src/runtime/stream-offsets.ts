/**
 * Offset encoding for stores that mint their own integer-backed offsets, and
 * storage-path helpers.
 *
 * `formatOffset`/`parseOffset` are a *store-private* encoding: the SQL, Redis
 * and MongoDB conversation stores use `<readSeq>_<seq>` — two 16-digit
 * zero-padded integers, matching the DS reference server's offset shape, the
 * first component always `0` — to turn their integer sequence into an offset
 * and back. Runtime code outside a store treats offsets as opaque
 * (`streams/offset.ts`): it never parses them, and orders them only with
 * `compareOffsets`.
 */

// ─── Offset utilities ───────────────────────────────────────────────────────

const COMPONENT_PAD = 16;
const ZERO_COMPONENT = '0'.repeat(COMPONENT_PAD);

/**
 * Format an integer sequence number as a DS-compatible offset string.
 *
 * Produces `<readSeq>_<seq>` with both components zero-padded to 16 digits,
 * matching the DS reference server's offset format. The first component is
 * always `0` (Flue uses integer sequences, not segmented files).
 */
export function formatOffset(seq: number): string {
	if (seq === -1) return '-1';
	return `${ZERO_COMPONENT}_${String(seq).padStart(COMPONENT_PAD, '0')}`;
}

/**
 * Parse a DS offset string back to an integer sequence number.
 * Accepts the `<readSeq>_<seq>` format and extracts the second component.
 * Returns -1 for the sentinel `"-1"`. Throws on any other format.
 */
export function parseOffset(offset: string): number {
	if (offset === '-1') return -1;
	const match = /^\d+_(\d+)$/.exec(offset);
	const sequence = match?.[1];
	if (!sequence) {
		throw new Error(`[flue] Invalid stream offset: "${offset}".`);
	}
	return parseInt(sequence, 10);
}

const LEGACY_OFFSET = /^0{16}_(\d{16})$/;

/**
 * The batch ordinal encoded in an offset of exactly the {@link formatOffset}
 * shape, or `undefined` for any other token. Compatibility only: a
 * `ConversationStreamStore` written before `ConversationStreamBatch.ordinal`
 * existed mints `formatOffset` offsets and supplies no ordinal. First-party
 * stores always supply the ordinal, and a store with any other offset format
 * must.
 */
export function legacyOffsetOrdinal(offset: string): number | undefined {
	const sequence = LEGACY_OFFSET.exec(offset)?.[1];
	if (sequence === undefined) return undefined;
	const ordinal = Number(sequence);
	return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}

/**
 * Storage path of an agent instance's canonical conversation stream. The
 * format is a durable-storage contract: it keys persisted conversations.
 */
export function agentStreamPath(agentName: string, instanceId: string): string {
	return `agents/${agentName}/${instanceId}`;
}

// ─── Read limits ────────────────────────────────────────────────────────────

/** Default page size for durable stream reads. */
export const DEFAULT_READ_LIMIT = 100;
/** Server-defined cap on a single durable stream read. */
export const MAX_READ_LIMIT = 1000;
