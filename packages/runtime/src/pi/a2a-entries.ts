/**
 * Payload shapes of the two Pi entry kinds whose commit also fans out to
 * another Durable Stream (PI_UPGRADE_PLAN.md §2.5): `flue.a2a.send` lands in a
 * target entity's inbox, `flue.publish` in this entity's public events stream.
 *
 * The entry kinds are owned by `pi/docs.ts` (lane-adapter); these are the
 * payload shapes the storage lane needs before that lane merges, so the
 * co-transactional `flue_relay_outbox` insert in `commit-outbox.ts` has one
 * definition to read. When `pi/docs.ts` lands, its `defineEntry` tokens should
 * be typed with {@link A2aSendEntryData} and {@link PublishEntryData}.
 *
 * Everything here is pure JSON handling: no Pi runtime, no I/O.
 */

import type { JsonValue } from '@earendil-works/chord';
import type { StorageWrite } from '@earendil-works/pi-durable';

export const A2A_SEND_ENTRY_KIND = 'flue.a2a.send';
export const PUBLISH_ENTRY_KIND = 'flue.publish';

/** A Flue agent instance: agent name + instance id. */
export interface EntityAddress {
	readonly type: string;
	readonly id: string;
}

/** `data` of a `flue.a2a.send` entry. */
export interface A2aSendEntryData {
	readonly target: EntityAddress;
	/** Stable across `replay: "safe"` reruns; the receiver's dedup key. */
	readonly messageId: string;
	/** The JSON form of a `DeliveredMessage`. */
	readonly message: JsonValue;
}

/** `data` of a `flue.publish` entry. */
export interface PublishEntryData {
	readonly eventId: string;
	readonly event: JsonValue;
}

/** What the relay posts to a target inbox (one message per send). */
export interface A2aInboxMessage {
	readonly type: 'flue.a2a.message';
	readonly from: EntityAddress;
	readonly messageId: string;
	readonly message: JsonValue;
}

/** What the relay posts to this entity's events stream (one message per publish). */
export interface PublishedEvent {
	readonly type: 'flue.event';
	readonly from: EntityAddress;
	readonly eventId: string;
	readonly event: JsonValue;
}

/** One relay fan-out produced by one committed entry. */
export interface RelayItem {
	/** Durable Streams path, relative to the log's base URL. */
	readonly target: string;
	/** `Producer-Id` for this target; producer seqs are contiguous per `(target, producerId)`. */
	readonly producerId: string;
	readonly body: A2aInboxMessage | PublishedEvent;
}

const segment = (value: string): string => encodeURIComponent(value);

/** `flue/v1/{type}/{id}` — the root every stream of one entity lives under. */
export function entityStreamRoot(entity: EntityAddress): string {
	return `flue/v1/${segment(entity.type)}/${segment(entity.id)}`;
}

/** `{type}/{id}`, header-safe (Producer-Id must be a ByteString). */
export function entityProducerName(entity: EntityAddress): string {
	return `${segment(entity.type)}/${segment(entity.id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is EntityAddress {
	return (
		isRecord(value) &&
		typeof value.type === 'string' &&
		value.type.length > 0 &&
		typeof value.id === 'string' &&
		value.id.length > 0
	);
}

/** Validate a `flue.a2a.send` payload; throws on anything else. */
export function parseA2aSendEntryData(data: unknown): A2aSendEntryData {
	if (
		!isRecord(data) ||
		!isAddress(data.target) ||
		typeof data.messageId !== 'string' ||
		data.messageId.length === 0 ||
		!('message' in data)
	) {
		throw new TypeError(`[flue] Malformed ${A2A_SEND_ENTRY_KIND} entry data.`);
	}
	return data as unknown as A2aSendEntryData;
}

/** Validate a `flue.publish` payload; throws on anything else. */
export function parsePublishEntryData(data: unknown): PublishEntryData {
	if (
		!isRecord(data) ||
		typeof data.eventId !== 'string' ||
		data.eventId.length === 0 ||
		!('event' in data)
	) {
		throw new TypeError(`[flue] Malformed ${PUBLISH_ENTRY_KIND} entry data.`);
	}
	return data as unknown as PublishEntryData;
}

/**
 * The relay fan-out of one commit, in write order. A malformed relay entry
 * throws, which rolls the whole commit back: an A2A send is never committed
 * without its relay row.
 */
export function relayItemsFor(writes: readonly StorageWrite[], self: EntityAddress): RelayItem[] {
	const items: RelayItem[] = [];
	for (const write of writes) {
		if (write.type !== 'entry') continue;
		const entry = write.value;
		if (entry.kind === A2A_SEND_ENTRY_KIND) {
			const data = parseA2aSendEntryData(entry.data);
			items.push({
				target: `${entityStreamRoot(data.target)}/inbox`,
				producerId: `${entityProducerName(self)}->inbox`,
				body: {
					type: 'flue.a2a.message',
					from: { type: self.type, id: self.id },
					messageId: data.messageId,
					message: data.message,
				},
			});
		} else if (entry.kind === PUBLISH_ENTRY_KIND) {
			const data = parsePublishEntryData(entry.data);
			items.push({
				target: `${entityStreamRoot(self)}/events`,
				producerId: `${entityProducerName(self)}->events`,
				body: {
					type: 'flue.event',
					from: { type: self.type, id: self.id },
					eventId: data.eventId,
					event: data.event,
				},
			});
		}
	}
	return items;
}
