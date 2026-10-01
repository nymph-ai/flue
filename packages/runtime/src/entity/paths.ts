/**
 * Stream paths of addressable entities (PI_UPGRADE_PLAN.md §2.5), relative to
 * the log's base URL (`…/v1/stream` on a bare Durable Streams server, the
 * agents-server's public URL behind Electric):
 *
 * - `flue/v1/{type}/{id}/inbox`  — what other entities send it;
 * - `flue/v1/{type}/{id}/events` — what it publishes;
 *
 * `{type}` and `{id}` are `encodeURIComponent`-encoded, so an id like
 * `parent/key` stays one segment (`parent%2Fkey`).
 *
 * Two spellings of a path exist. The **log path** above is what
 * `DurableStreamLog` takes. `ElectricDurableStreamLog` percent-encodes each of
 * its segments once more when it builds the URL, and the server names the
 * stream by that URL path, so subscriptions and webhooks speak the **wire
 * path** (`parent%252Fkey`). {@link wirePath} and {@link logPathFromWire}
 * convert between them.
 */

import { decodeBase64, encodeBase64 } from '../base64.ts';
import { type EntityAddress, entityStreamRoot } from './events.ts';

export type { EntityAddress } from './events.ts';

export function inboxPath(entity: EntityAddress): string {
	return `${entityStreamRoot(entity)}/inbox`;
}

export function eventsPath(entity: EntityAddress): string {
	return `${entityStreamRoot(entity)}/events`;
}

/**
 * A path no one writes, one per entity: the literal pattern of its observe
 * subscription, whose real members are the explicit observed streams (a
 * subscription needs a pattern or at least one stream at creation).
 */
export function wakeAnchorPath(entity: EntityAddress): string {
	return `${entityStreamRoot(entity)}/wake`;
}

/** The pattern of the shared inbox subscription, in wire form. */
export const INBOX_PATTERN = 'flue/v1/*/*/inbox';

/** Log path → wire path: each segment percent-encoded once more. */
export function wirePath(logPath: string): string {
	return logPath
		.split('/')
		.filter((segment) => segment.length > 0)
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

/** Wire path (from a subscription or webhook, leading slash or not) → log path. */
export function logPathFromWire(path: string): string {
	return path
		.split('/')
		.filter((segment) => segment.length > 0)
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join('/');
}

const INBOX_RE = /^flue\/v1\/([^/]+)\/([^/]+)\/inbox$/;

/** The entity whose inbox a log path is, if it is one. */
export function entityOfInboxPath(logPath: string): EntityAddress | undefined {
	const match = INBOX_RE.exec(logPath);
	if (!match) return undefined;
	try {
		const type = decodeURIComponent(match[1] as string);
		const id = decodeURIComponent(match[2] as string);
		return type && id ? { type, id } : undefined;
	} catch {
		return undefined;
	}
}

/** `{type}/{id}`, unambiguous (both segments encoded). */
export function entityKey(entity: EntityAddress): string {
	return `${encodeURIComponent(entity.type)}/${encodeURIComponent(entity.id)}`;
}

export function sameEntity(a: EntityAddress, b: EntityAddress): boolean {
	return a.type === b.type && a.id === b.id;
}

function base64Url(text: string): string {
	return encodeBase64(new TextEncoder().encode(text))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

function fromBase64Url(value: string): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
			decodeBase64(base64 + '='.repeat((4 - (base64.length % 4)) % 4)),
		);
	} catch {
		return undefined;
	}
}

const OBSERVE_SUBSCRIPTION_PREFIX = 'flue-obs.';

/**
 * The id of one entity's observe subscription. It names the entity, so the
 * (signed) `subscription_id` of a wake routes it to exactly the observer.
 */
export function observeSubscriptionId(entity: EntityAddress): string {
	return `${OBSERVE_SUBSCRIPTION_PREFIX}${base64Url(entity.type)}.${base64Url(entity.id)}`;
}

/** The observer an observe subscription id names. */
export function entityOfObserveSubscription(subscriptionId: string): EntityAddress | undefined {
	if (!subscriptionId.startsWith(OBSERVE_SUBSCRIPTION_PREFIX)) return undefined;
	const parts = subscriptionId.slice(OBSERVE_SUBSCRIPTION_PREFIX.length).split('.');
	if (parts.length !== 2) return undefined;
	const type = fromBase64Url(parts[0] as string);
	const id = fromBase64Url(parts[1] as string);
	return type && id ? { type, id } : undefined;
}

/** The default id of the shared inbox subscription. */
export const INBOX_SUBSCRIPTION_ID = 'flue-inbox';
