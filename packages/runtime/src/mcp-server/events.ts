/**
 * EventProjection over Electric durable streams.
 *
 * Implements dual event projection:
 * 1. Native MCP Events (webhook-based signed delivery and challenge verification)
 * 2. Core fallback (eventstream://head and eventstream://after/<cursor> resources + subscriptions/listen)
 *
 * Reference: docs/mcp-capability-projection.md § 10
 */

import type { ElectricEvent, EventSubscription } from './types.ts';

export interface WebhookDeliveryRecord {
	id: string;
	subscriptionId: string;
	eventId: string;
	cursor: string;
	statusCode?: number;
	status: 'success' | 'failed';
	error?: string;
	timestamp: string;
}

export class EventProjection {
	private readonly streams = new Map<string, ElectricEvent[]>();
	private readonly subscriptions = new Map<string, EventSubscription>();
	private readonly deliveryLogs: WebhookDeliveryRecord[] = [];
	private nextOffset = 1;

	getDeliveryLogs(): readonly WebhookDeliveryRecord[] {
		return this.deliveryLogs;
	}

	/**
	 * Append an event to a durable stream.
	 */
	appendEvent(streamId: string, name: string, data: unknown): ElectricEvent {
		let stream = this.streams.get(streamId);
		if (!stream) {
			stream = [];
			this.streams.set(streamId, stream);
		}

		const offset = this.nextOffset++;
		const cursor = `${String(offset).padStart(16, '0')}_0000000000000001`;
		const eventId = `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const timestamp = new Date().toISOString();

		const event: ElectricEvent = {
			eventId,
			streamId,
			name,
			cursor,
			timestamp,
			data,
		};

		stream.push(event);
		return event;
	}

	/**
	 * Read events from stream after a given cursor.
	 */
	readEvents(
		streamId: string,
		afterCursor?: string,
		limit = 50,
	): { events: ElectricEvent[]; nextCursor: string | null; headCursor: string | null } {
		const stream = this.streams.get(streamId) ?? [];
		if (stream.length === 0) {
			return { events: [], nextCursor: null, headCursor: null };
		}

		const headCursor = stream[stream.length - 1]!.cursor;

		let startIndex = 0;
		if (afterCursor) {
			const idx = stream.findIndex((e) => e.cursor === afterCursor);
			if (idx >= 0) {
				startIndex = idx + 1;
			}
		}

		const slice = stream.slice(startIndex, startIndex + limit);
		const nextCursor = slice.length > 0 ? slice[slice.length - 1]!.cursor : afterCursor ?? null;

		return {
			events: slice,
			nextCursor,
			headCursor,
		};
	}

	/**
	 * Get head cursor for stream.
	 */
	getHeadCursor(streamId: string): string | null {
		const stream = this.streams.get(streamId);
		if (!stream || stream.length === 0) return null;
		return stream[stream.length - 1]!.cursor;
	}

	/**
	 * List active stream IDs.
	 */
	listStreams(): string[] {
		return Array.from(this.streams.keys()).sort();
	}

	// --------------------------------------------------------------------------
	// Native MCP Events Webhook Subscriptions
	// --------------------------------------------------------------------------

	/**
	 * Subscribe a webhook callback URL to stream events.
	 */
	async subscribe(params: {
		callbackUrl: string;
		secret?: string;
		streamId?: string;
		filter?: Record<string, unknown>;
		cursor?: string;
		skipVerification?: boolean;
	}): Promise<{ subscription: EventSubscription; refreshBefore: string }> {
		const subId = `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const now = new Date().toISOString();

		const subscription: EventSubscription = {
			id: subId,
			callbackUrl: params.callbackUrl,
			secret: params.secret,
			streamId: params.streamId,
			filter: params.filter,
			cursor: params.cursor,
			createdAt: now,
		};

		// Run Standard Webhooks challenge verification if secret is provided and not skipped
		if (params.secret && !params.skipVerification) {
			await this.verifyWebhookHandshake(params.callbackUrl, params.secret, subId);
		}

		this.subscriptions.set(subId, subscription);

		// Refresh before 24 hours
		const refreshBefore = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
		return { subscription, refreshBefore };
	}

	/**
	 * Unsubscribe an active webhook subscription.
	 */
	unsubscribe(subscriptionId: string): boolean {
		return this.subscriptions.delete(subscriptionId);
	}

	getSubscription(subscriptionId: string): EventSubscription | undefined {
		return this.subscriptions.get(subscriptionId);
	}

	listSubscriptions(): EventSubscription[] {
		return Array.from(this.subscriptions.values());
	}

	/**
	 * Standard Webhooks verification challenge.
	 */
	private async verifyWebhookHandshake(
		callbackUrl: string,
		secret: string,
		subscriptionId: string,
	): Promise<void> {
		const challenge = `challenge_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const payload = JSON.stringify({
			type: 'verification',
			challenge,
			subscriptionId,
		});

		const signature = await this.signStandardWebhook(secret, msgId, timestamp, payload);

		try {
			const res = await fetch(callbackUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'webhook-id': msgId,
					'webhook-timestamp': timestamp,
					'webhook-signature': signature,
					'x-mcp-subscription-id': subscriptionId,
				},
				body: payload,
			});

			if (!res.ok) {
				throw new Error(`Webhook challenge rejected with HTTP ${res.status}`);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Callback URL verification failed: ${msg}`);
		}
	}

	/**
	 * Sign Standard Webhook payload using HMAC-SHA256.
	 */
	async signStandardWebhook(
		secret: string,
		msgId: string,
		timestamp: string,
		payload: string,
	): Promise<string> {
		const cleanSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
		const encoder = new TextEncoder();
		const keyData = encoder.encode(cleanSecret);
		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			keyData,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);

		const toSign = `${msgId}.${timestamp}.${payload}`;
		const sigBytes = new Uint8Array(
			await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(toSign)),
		);

		let binary = '';
		for (let i = 0; i < sigBytes.length; i++) {
			binary += String.fromCharCode(sigBytes[i]!);
		}
		const b64 = btoa(binary);
		return `v1,${b64}`;
	}

	// --------------------------------------------------------------------------
	// Core Fallback Resources (eventstream://)
	// --------------------------------------------------------------------------

	/**
	 * Read eventstream://head resource.
	 */
	readHeadResource(streamId: string): { content: string; mimeType: string } {
		const stream = this.streams.get(streamId) ?? [];
		const headCursor = stream.length > 0 ? stream[stream.length - 1]!.cursor : null;
		const payload = {
			streamId,
			headCursor,
			eventCount: stream.length,
			updatedAt: stream.length > 0 ? stream[stream.length - 1]!.timestamp : new Date().toISOString(),
		};
		return {
			content: JSON.stringify(payload, null, 2),
			mimeType: 'application/json',
		};
	}

	/**
	 * Read eventstream://after/<cursor> resource.
	 */
	readAfterResource(
		streamId: string,
		afterCursor: string,
		limit = 50,
	): { content: string; mimeType: string } {
		const result = this.readEvents(streamId, afterCursor, limit);
		return {
			content: JSON.stringify(result, null, 2),
			mimeType: 'application/json',
		};
	}
}
