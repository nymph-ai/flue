/**
 * The entity events Flue puts on Electric (docs/cloudflare-native.md rules 2
 * and 5): what a send appends to a target's inbox and what a publish appends
 * to the publisher's events stream. Each carries a deterministic id —
 * `{self}/{taskId}/{callId}` for a tool call — that the receiver
 * deduplicates on.
 *
 * Everything here is pure JSON handling: no Pi runtime, no I/O.
 */

import type { JsonValue } from '@earendil-works/chord';

/** A Flue agent instance: agent name + instance id. */
export interface EntityAddress {
	readonly type: string;
	readonly id: string;
}

/**
 * What a relayed message asks the target to do besides being delivered:
 * `schedule` — arm (or cancel) a schedule on the target instead of admitting
 * now; `spawn` — create the target instance (create-only) with this seed.
 */
export type A2aDirective =
	| { readonly kind: 'schedule'; readonly scheduleId: string; readonly atMs: number }
	| { readonly kind: 'cancel-schedule'; readonly scheduleId: string }
	| { readonly kind: 'spawn'; readonly uid: string; readonly initialData?: JsonValue };

/** What a send appends to the target's inbox (one message per send). */
export interface A2aInboxMessage {
	readonly type: 'flue.a2a.message';
	readonly from: EntityAddress;
	/** Deterministic, stable across `replay: "safe"` reruns: the receiver's dedup key. */
	readonly messageId: string;
	readonly message: JsonValue;
	readonly directive?: A2aDirective;
}

/** What a publish appends to this entity's events stream (one message per publish). */
export interface PublishedEvent {
	readonly type: 'flue.event';
	readonly from: EntityAddress;
	readonly eventId: string;
	readonly event: JsonValue;
}

const segment = (value: string): string => encodeURIComponent(value);

/** `flue/v1/{type}/{id}` — the root every stream of one entity lives under. */
export function entityStreamRoot(entity: EntityAddress): string {
	return `flue/v1/${segment(entity.type)}/${segment(entity.id)}`;
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

function isDirective(value: unknown): value is A2aDirective {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case 'schedule':
			return (
				typeof value.scheduleId === 'string' &&
				value.scheduleId.length > 0 &&
				Number.isFinite(value.atMs)
			);
		case 'cancel-schedule':
			return typeof value.scheduleId === 'string' && value.scheduleId.length > 0;
		case 'spawn':
			return typeof value.uid === 'string' && value.uid.length > 0;
		default:
			return false;
	}
}

/** Validate a relayed inbox message; `undefined` for anything else on an inbox stream. */
export function parseA2aInboxMessage(value: unknown): A2aInboxMessage | undefined {
	if (
		!isRecord(value) ||
		value.type !== 'flue.a2a.message' ||
		!isAddress(value.from) ||
		typeof value.messageId !== 'string' ||
		value.messageId.length === 0 ||
		!('message' in value) ||
		(value.directive !== undefined && !isDirective(value.directive))
	) {
		return undefined;
	}
	return value as unknown as A2aInboxMessage;
}
