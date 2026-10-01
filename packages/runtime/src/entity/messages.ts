/**
 * `EntityMessage` (the JSON form services and tools speak) ↔ Flue's
 * `DeliveredMessage` (what `FluePiHost.admit` takes).
 */
import type { JsonValue } from '@earendil-works/chord';
import type { DeliveredMessage } from '../types.ts';
import { entityKey } from './paths.ts';
import type { EntityMessage, EntityRef } from './services.ts';

export class EntityMessageError extends TypeError {
	constructor(message: string) {
		super(`[flue] ${message}`);
		this.name = 'EntityMessageError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate an `EntityMessage`; throws {@link EntityMessageError}. */
export function parseEntityMessage(value: unknown): EntityMessage {
	if (!isRecord(value)) throw new EntityMessageError('An entity message must be a JSON object.');
	if (value.text !== undefined && typeof value.text !== 'string') {
		throw new EntityMessageError('An entity message `text` must be a string.');
	}
	if (value.attachments !== undefined) {
		throw new EntityMessageError('Entity messages cannot carry attachments yet.');
	}
	if (value.text === undefined && value.data === undefined) {
		throw new EntityMessageError('An entity message needs `text` or `data`.');
	}
	return {
		...(value.text === undefined ? {} : { text: value.text as string }),
		...(value.data === undefined ? {} : { data: value.data as JsonValue }),
	};
}

/** JSON-safe copy of a message for an entry payload. */
export function entityMessageJson(message: EntityMessage): JsonValue {
	return JSON.parse(JSON.stringify(message)) as JsonValue;
}

function bodyOf(message: EntityMessage): string {
	const parts: string[] = [];
	if (message.text !== undefined) parts.push(message.text);
	if (message.data !== undefined) parts.push(JSON.stringify(message.data));
	return parts.join('\n\n');
}

/**
 * What an entity receives: a signal (`a2a.message`) naming its sender, so the
 * model can tell an entity's message from a user's and answer it with
 * `send_message`.
 */
export function deliveredFromEntity(
	from: EntityRef,
	messageId: string,
	message: EntityMessage,
	type = 'a2a.message',
): DeliveredMessage {
	return {
		kind: 'signal',
		type,
		body: bodyOf(message),
		attributes: { from_type: from.type, from_id: from.id, from: entityKey(from), message_id: messageId },
	};
}

/** What a self-schedule delivers when it fires. */
export function deliveredFromSchedule(scheduleId: string, message: EntityMessage): DeliveredMessage {
	return {
		kind: 'signal',
		type: 'schedule.fired',
		body: bodyOf(message),
		attributes: { schedule_id: scheduleId },
	};
}
