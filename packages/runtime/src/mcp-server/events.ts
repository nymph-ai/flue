/**
 * EventProjection over Electric durable streams and MCP Events engine.
 *
 * Implements:
 * 1. Native MCP Events (Standard Webhooks, HMAC signing, challenge handshake, replay, delivery tracking)
 * 2. Core fallback (eventstream://head and eventstream://after/<cursor> resources + subscriptions/listen)
 * 3. Unified SQLite persistence with in-memory test fallback
 *
 * Reference: docs/mcp-capability-projection.md § 10
 */

import type { DurableStreamLog } from '../streams/log.ts';
import type { DurableObjectStateLike, EventPort, McpAuditLogPort, SqlStorageLike } from './ports.ts';
import type {
	AuditLogEntry,
	ElectricEvent,
	EventDefinition,
	EventSubscription,
	WebhookDeliveryRecord,
} from './types.ts';

export const CANONICAL_EVENT_DEFINITIONS: EventDefinition[] = [
	{
		name: 'task_changed',
		description:
			'Fired whenever an asynchronous task changes state (queued, running, completed, failed, input_required, cancelled). Delivers state revision, cursor, status, summary, and durable result reference.',
		delivery: ['webhook'],
		inputSchema: {
			type: 'object',
			properties: {
				filter: {
					type: 'object',
					properties: {
						taskId: { type: 'string', description: 'Filter notifications to a specific task ID.' },
						correlationId: {
							type: 'string',
							description: 'Filter notifications to a specific conversation or correlation ID.',
						},
					},
					description: 'Optional filter criteria for events.',
				},
				taskId: { type: 'string', description: 'Filter notifications to a specific task ID.' },
				correlationId: {
					type: 'string',
					description: 'Filter notifications to a specific conversation or correlation ID.',
				},
				cursor: {
					type: 'string',
					description: 'Opaque cursor for event streaming and replay.',
				},
			},
		},
		payloadSchema: {
			type: 'object',
			properties: {
				event: { type: 'string', enum: ['task_changed'] },
				eventId: { type: 'string', description: 'Unique UUID for event deduplication.' },
				taskId: { type: 'string', description: 'Durable task ID.' },
				correlationId: { type: 'string', description: 'Caller-supplied correlation ID.' },
				revision: { type: 'integer', description: 'Monotonically increasing state revision.' },
				cursor: { type: 'string', description: 'Opaque cursor for event streaming and replay.' },
				status: {
					type: 'string',
					enum: ['queued', 'running', 'completed', 'failed', 'input_required', 'cancelled'],
				},
				summary: { type: 'string', description: 'Human-readable summary of the state change.' },
				resultReference: { type: 'string', description: 'URI pointing to the durable result.' },
				error: { type: 'string', description: 'Error message if status is failed.' },
				timestamp: { type: 'string', format: 'date-time', description: 'ISO-8601 timestamp.' },
			},
			required: ['event', 'eventId', 'taskId', 'revision', 'status', 'summary', 'timestamp'],
		},
		schema: {
			type: 'object',
			properties: {
				event: { type: 'string', enum: ['task_changed'] },
				eventId: { type: 'string', description: 'Unique UUID for event deduplication.' },
				taskId: { type: 'string', description: 'Durable task ID.' },
				correlationId: { type: 'string', description: 'Caller-supplied correlation ID.' },
				revision: { type: 'integer', description: 'Monotonically increasing state revision.' },
				cursor: { type: 'string', description: 'Opaque cursor for event streaming and replay.' },
				status: {
					type: 'string',
					enum: ['queued', 'running', 'completed', 'failed', 'input_required', 'cancelled'],
				},
				summary: {
					type: 'string',
					description: 'Short human-readable summary of the state change.',
				},
				resultReference: { type: 'string', description: 'URI pointing to the durable result.' },
				error: { type: 'string', description: 'Error message if status is failed.' },
				timestamp: { type: 'string', format: 'date-time', description: 'ISO-8601 timestamp.' },
			},
			required: ['event', 'eventId', 'taskId', 'revision', 'status', 'summary', 'timestamp'],
		},
	},
];

// -----------------------------------------------------------------------------
// Webhook & Crypto Utilities
// -----------------------------------------------------------------------------

export function decodeWebhookSecret(secret: string): Uint8Array {
	let raw = secret;
	if (raw.startsWith('whsec_')) {
		raw = raw.slice('whsec_'.length);
	}
	try {
		let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
		while (b64.length % 4 !== 0) {
			b64 += '=';
		}
		const binary = atob(b64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		return new TextEncoder().encode(secret);
	}
}

export function constantTimeEqual(a: string, b: string): boolean {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const enc = new TextEncoder();
	const aBytes = enc.encode(a);
	const bBytes = enc.encode(b);
	if (aBytes.length !== bBytes.length) return false;
	let mismatch = 0;
	for (let i = 0; i < aBytes.length; i++) {
		mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
	}
	return mismatch === 0;
}

export async function signStandardWebhook(
	secret: string,
	msgId: string,
	timestamp: string,
	payload: string,
): Promise<string> {
	const keyBytes = decodeWebhookSecret(secret);
	const key = await crypto.subtle.importKey(
		'raw',
		keyBytes as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signedContent = `${msgId}.${timestamp}.${payload}`;
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(signedContent) as BufferSource,
	);
	const b64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return `v1,${b64}`;
}

export async function verifyStandardWebhook(
	secret: string,
	msgId: string,
	timestamp: string,
	payload: string,
	signatureHeader: string,
): Promise<boolean> {
	const expected = await signStandardWebhook(secret, msgId, timestamp, payload);
	const parts = signatureHeader.split(' ');
	for (const part of parts) {
		if (constantTimeEqual(part, expected)) {
			return true;
		}
	}
	return false;
}

export async function signPayload(secret: string, payload: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret) as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(payload) as BufferSource,
	);
	const hex = Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `sha256=${hex}`;
}

export async function verifyPayloadSignature(
	secret: string,
	payload: string,
	signatureHeader: string,
): Promise<boolean> {
	const expected = await signPayload(secret, payload);
	return constantTimeEqual(expected, signatureHeader);
}

export async function deriveSubscriptionId(
	callbackUrl: string,
	eventName = 'task_changed',
	filter?: Record<string, unknown>,
): Promise<string> {
	const filterKey = `${filter?.taskId ?? ''}:${filter?.correlationId ?? ''}`;
	const key = `${eventName}:${callbackUrl}:${filterKey}`;
	const hashBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(key) as BufferSource,
	);
	const hex = Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.slice(0, 16)
		.join('');
	return `sub_${hex}`;
}

// -----------------------------------------------------------------------------
// Event Projection Engine
// -----------------------------------------------------------------------------

export interface EventProjectionOptions {
	sql?: SqlStorageLike;
	ctx?: DurableObjectStateLike;
	streamLog?: DurableStreamLog;
}

export class EventProjection implements EventPort, McpAuditLogPort {
	private readonly streams = new Map<string, ElectricEvent[]>();
	private readonly subscriptions = new Map<string, EventSubscription>();
	private readonly deliveryLogs: WebhookDeliveryRecord[] = [];
	private readonly auditLogs: AuditLogEntry[] = [];
	private nextOffset = 1;

	private readonly sql?: SqlStorageLike;
	private readonly ctx?: DurableObjectStateLike;
	private readonly streamLog?: DurableStreamLog;

	constructor(options?: EventProjectionOptions) {
		this.sql = options?.sql;
		this.ctx = options?.ctx;
		this.streamLog = options?.streamLog;

		if (this.sql) {
			this.initSchema();
		}
	}

	private initSchema(): void {
		if (!this.sql) return;
		try {
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_audit_logs (
				id TEXT PRIMARY KEY,
				category TEXT NOT NULL,
				details TEXT NOT NULL,
				timestamp TEXT NOT NULL
			)`);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_timestamp ON mcp_audit_logs(timestamp)`,
			);
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_subscriptions (
				id TEXT PRIMARY KEY,
				callback_url TEXT NOT NULL,
				secret TEXT,
				stream_id TEXT,
				filter_task_id TEXT,
				filter_correlation_id TEXT,
				cursor TEXT,
				created_at TEXT NOT NULL
			)`);
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_events (
				event_id TEXT PRIMARY KEY,
				stream_id TEXT NOT NULL,
				name TEXT NOT NULL,
				cursor TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				data TEXT NOT NULL
			)`);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_mcp_events_stream ON mcp_events(stream_id, cursor)`,
			);
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_deliveries (
				id TEXT PRIMARY KEY,
				event_id TEXT NOT NULL,
				subscription_id TEXT NOT NULL,
				task_id TEXT,
				revision INTEGER,
				cursor TEXT NOT NULL,
				status TEXT NOT NULL,
				status_code INTEGER,
				error TEXT,
				attempt INTEGER NOT NULL DEFAULT 1,
				timestamp TEXT NOT NULL
			)`);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_mcp_deliveries_sub ON mcp_deliveries(subscription_id)`,
			);
		} catch (error) {
			console.error('[flue:events] Failed to initialize SQLite schema', error);
		}
	}

	logAudit(category: string, details: Record<string, unknown>): void {
		const id = `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const timestamp = new Date().toISOString();
		if (this.sql) {
			try {
				this.sql.exec(
					`INSERT INTO mcp_audit_logs (id, category, details, timestamp) VALUES (?, ?, ?, ?)`,
					id,
					category,
					JSON.stringify(details),
					timestamp,
				);
			} catch (e) {
				console.error('Failed to write audit log to sqlite:', e);
			}
		} else {
			this.auditLogs.unshift({ id, category, details, timestamp });
			if (this.auditLogs.length > 200) this.auditLogs.pop();
		}
	}

	getAuditLogs(limit = 50): AuditLogEntry[] {
		if (this.sql) {
			try {
				const rows = this.sql
					.exec(`SELECT * FROM mcp_audit_logs ORDER BY timestamp DESC LIMIT ?`, limit)
					.toArray();
				return rows.map((r) => ({
					id: String(r.id),
					category: String(r.category),
					details: r.details ? JSON.parse(String(r.details)) : null,
					timestamp: String(r.timestamp),
				}));
			} catch {
				return [];
			}
		}
		return this.auditLogs.slice(0, limit);
	}

	getDeliveryLogs(): readonly WebhookDeliveryRecord[] {
		if (this.sql) {
			try {
				const rows = this.sql
					.exec(`SELECT * FROM mcp_deliveries ORDER BY timestamp DESC LIMIT 100`)
					.toArray();
				return rows.map((r) => ({
					id: String(r.id),
					subscriptionId: String(r.subscription_id),
					eventId: String(r.event_id),
					taskId: r.task_id ? String(r.task_id) : undefined,
					revision: r.revision !== null ? Number(r.revision) : undefined,
					cursor: String(r.cursor),
					status: r.status as 'delivered' | 'failed' | 'success',
					statusCode: r.status_code !== null ? Number(r.status_code) : undefined,
					error: r.error ? String(r.error) : undefined,
					attempt: Number(r.attempt ?? 1),
					timestamp: String(r.timestamp),
				}));
			} catch {
				return [];
			}
		}
		return this.deliveryLogs;
	}

	/**
	 * Append an event to a durable stream and dispatch webhook notifications.
	 */
	appendEvent(
		streamId: string,
		name: string,
		data: unknown,
		customCursor?: string,
	): ElectricEvent {
		const offset = this.nextOffset++;
		const cursor =
			customCursor ??
			`${String(offset).padStart(16, '0')}_0000000000000001`;
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

		if (this.sql) {
			try {
				this.sql.exec(
					`INSERT INTO mcp_events (event_id, stream_id, name, cursor, timestamp, data)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					eventId,
					streamId,
					name,
					cursor,
					timestamp,
					JSON.stringify(data),
				);
			} catch (e) {
				console.error('[flue:events] Failed to insert event into SQLite:', e);
			}
		} else {
			let stream = this.streams.get(streamId);
			if (!stream) {
				stream = [];
				this.streams.set(streamId, stream);
			}
			stream.push(event);
		}

		// Also mirror to DurableStreamLog if provided
		if (this.streamLog) {
			const promise = this.streamLog.append(streamId, [event]);
			if (this.ctx?.waitUntil) {
				this.ctx.waitUntil(promise);
			}
		}

		// Dispatch to active subscribers
		this.dispatchToSubscribers(event);

		return event;
	}

	/**
	 * Deliver an event to all matching subscriptions.
	 */
	private dispatchToSubscribers(event: ElectricEvent): void {
		const subs = this.listSubscriptions();
		const eventData = (event.data && typeof event.data === 'object'
			? event.data
			: {}) as Record<string, unknown>;

		const taskId = (eventData.taskId ?? eventData.id) as string | undefined;
		const correlationId = eventData.correlationId as string | undefined;

		for (const sub of subs) {
			if (sub.streamId && sub.streamId !== event.streamId) continue;
			if (sub.filter) {
				if (sub.filter.taskId && sub.filter.taskId !== taskId) continue;
				if (sub.filter.correlationId && sub.filter.correlationId !== correlationId) continue;
			}

			const p = this.deliverEvent(sub, event);
			if (this.ctx?.waitUntil) {
				this.ctx.waitUntil(p);
			} else {
				void p;
			}
		}
	}

	/**
	 * Deliver an event to a specific subscription with Standard Webhooks signing.
	 */
	async deliverEvent(sub: EventSubscription, event: ElectricEvent): Promise<void> {
		const cursor = event.cursor;
		const timestampSeconds = Math.floor(Date.now() / 1000).toString();

		const eventEnvelope = {
			eventId: event.eventId,
			name: event.name,
			timestamp: event.timestamp || new Date().toISOString(),
			data: event.data,
			cursor,
		};
		const payloadString = JSON.stringify(eventEnvelope);

		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'webhook-id': event.eventId,
			'webhook-timestamp': timestampSeconds,
			'x-mcp-subscription-id': sub.id,
			'x-mcp-event-id': event.eventId,
			'x-mcp-cursor': cursor,
			'x-mcp-event-type': event.name,
			'user-agent': 'NymphAI-Flue/2.2.2 (MCP 2026-07-28)',
		};

		const eventData = (event.data && typeof event.data === 'object'
			? event.data
			: {}) as Record<string, unknown>;
		if (eventData.taskId) {
			headers['x-mcp-task-id'] = String(eventData.taskId);
		}
		if (eventData.revision) {
			headers['x-mcp-revision'] = String(eventData.revision);
		}

		if (sub.secret) {
			try {
				headers['webhook-signature'] = await signStandardWebhook(
					sub.secret,
					event.eventId,
					timestampSeconds,
					payloadString,
				);
				headers['x-mcp-event-signature'] = await signPayload(sub.secret, payloadString);
			} catch (signErr) {
				console.error('[flue:events] Failed to sign payload:', signErr);
			}
		}

		const deliveryId = `del_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const now = new Date().toISOString();

		this.logAudit('mcp:deliverEvent:attempt', {
			deliveryId,
			subId: sub.id,
			callbackUrl: sub.callbackUrl,
			eventId: event.eventId,
		});

		try {
			const res = await fetch(sub.callbackUrl, {
				method: 'POST',
				headers,
				body: payloadString,
			});

			const statusCode = res.status;
			const isSuccess = res.ok;

			const record: WebhookDeliveryRecord = {
				id: deliveryId,
				subscriptionId: sub.id,
				eventId: event.eventId,
				taskId: eventData.taskId ? String(eventData.taskId) : undefined,
				revision: eventData.revision ? Number(eventData.revision) : undefined,
				cursor,
				statusCode,
				status: isSuccess ? 'delivered' : 'failed',
				attempt: 1,
				timestamp: now,
			};

			if (this.sql) {
				try {
					this.sql.exec(
						`INSERT INTO mcp_deliveries (id, event_id, subscription_id, task_id, revision, cursor, status, status_code, error, attempt, timestamp)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						deliveryId,
						event.eventId,
						sub.id,
						record.taskId ?? null,
						record.revision ?? null,
						cursor,
						record.status,
						statusCode,
						isSuccess ? null : `HTTP ${statusCode}`,
						1,
						now,
					);
				} catch (e) {
					console.error('[flue:events] Failed to record delivery in SQLite:', e);
				}
			} else {
				this.deliveryLogs.push(record);
			}

			this.logAudit('mcp:deliverEvent:completed', {
				deliveryId,
				statusCode,
				success: isSuccess,
			});
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			const record: WebhookDeliveryRecord = {
				id: deliveryId,
				subscriptionId: sub.id,
				eventId: event.eventId,
				taskId: eventData.taskId ? String(eventData.taskId) : undefined,
				revision: eventData.revision ? Number(eventData.revision) : undefined,
				cursor,
				status: 'failed',
				error: errorMsg,
				attempt: 1,
				timestamp: now,
			};

			if (this.sql) {
				try {
					this.sql.exec(
						`INSERT INTO mcp_deliveries (id, event_id, subscription_id, task_id, revision, cursor, status, status_code, error, attempt, timestamp)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						deliveryId,
						event.eventId,
						sub.id,
						record.taskId ?? null,
						record.revision ?? null,
						cursor,
						'failed',
						null,
						errorMsg,
						1,
						now,
					);
				} catch (e) {
					console.error('[flue:events] Failed to record failed delivery:', e);
				}
			} else {
				this.deliveryLogs.push(record);
			}

			this.logAudit('mcp:deliverEvent:error', {
				deliveryId,
				error: errorMsg,
			});
		}
	}

	/**
	 * Read events from stream after a given cursor.
	 */
	readEvents(
		streamId: string,
		afterCursor?: string,
		limit = 50,
	): { events: ElectricEvent[]; nextCursor: string | null; headCursor: string | null } {
		if (this.sql) {
			try {
				let query = `SELECT * FROM mcp_events WHERE stream_id = ?`;
				const bindings: unknown[] = [streamId];
				if (afterCursor) {
					query += ` AND cursor > ?`;
					bindings.push(afterCursor);
				}
				query += ` ORDER BY cursor ASC LIMIT ?`;
				bindings.push(limit);

				const rows = this.sql.exec(query, ...bindings).toArray();
				const events: ElectricEvent[] = rows.map((r) => ({
					eventId: String(r.event_id),
					streamId: String(r.stream_id),
					name: String(r.name),
					cursor: String(r.cursor),
					timestamp: String(r.timestamp),
					data: r.data ? JSON.parse(String(r.data)) : null,
				}));

				const headCursor = this.getHeadCursor(streamId);
				const nextCursor =
					events.length > 0 ? (events[events.length - 1]?.cursor ?? null) : afterCursor ?? null;

				return { events, nextCursor, headCursor };
			} catch {
				return { events: [], nextCursor: null, headCursor: null };
			}
		}

		const stream = this.streams.get(streamId) ?? [];
		if (stream.length === 0) {
			return { events: [], nextCursor: null, headCursor: null };
		}

		const headCursor = stream[stream.length - 1]?.cursor ?? null;

		let startIndex = 0;
		if (afterCursor) {
			const idx = stream.findIndex((e) => e.cursor === afterCursor);
			if (idx >= 0) {
				startIndex = idx + 1;
			}
		}

		const slice = stream.slice(startIndex, startIndex + limit);
		const nextCursor =
			slice.length > 0 ? (slice[slice.length - 1]?.cursor ?? null) : afterCursor ?? null;

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
		if (this.sql) {
			try {
				const rows = this.sql
					.exec(
						`SELECT cursor FROM mcp_events WHERE stream_id = ? ORDER BY cursor DESC LIMIT 1`,
						streamId,
					)
					.toArray();
				return rows[0]?.cursor ? String(rows[0].cursor) : null;
			} catch {
				return null;
			}
		}

		const stream = this.streams.get(streamId);
		if (!stream || stream.length === 0) return null;
		return stream[stream.length - 1]?.cursor ?? null;
	}

	/**
	 * List active stream IDs.
	 */
	listStreams(): string[] {
		if (this.sql) {
			try {
				const rows = this.sql
					.exec(`SELECT DISTINCT stream_id FROM mcp_events ORDER BY stream_id ASC`)
					.toArray();
				return rows.map((r) => String(r.stream_id));
			} catch {
				return [];
			}
		}
		return Array.from(this.streams.keys()).sort();
	}

	// --------------------------------------------------------------------------
	// Native MCP Events Webhook Subscriptions
	// --------------------------------------------------------------------------

	/**
	 * Subscribe a webhook callback URL to stream events.
	 */
	async subscribe(params: {
		callbackUrl?: string;
		delivery?: { type?: string; mode?: string; url?: string; secret?: string };
		secret?: string;
		streamId?: string;
		filter?: Record<string, unknown>;
		cursor?: string;
		fromRevision?: number;
		subscriptionId?: string;
		skipVerification?: boolean;
	}): Promise<{ subscription: EventSubscription; refreshBefore: string }> {
		const delivery = params.delivery ?? {};
		const callbackUrl = String(
			delivery.url ?? params.callbackUrl ?? '',
		);
		if (!callbackUrl) {
			throw new Error('Missing delivery.url or callbackUrl for events/subscribe');
		}

		const secret = delivery.secret ?? params.secret;
		const streamId = params.streamId;
		const filter = params.filter;

		let subId = params.subscriptionId;
		if (!subId) {
			subId = await deriveSubscriptionId(callbackUrl, 'task_changed', filter);
		}

		const now = new Date().toISOString();
		const subscription: EventSubscription = {
			id: subId,
			callbackUrl,
			secret,
			streamId,
			filter,
			cursor: params.cursor,
			createdAt: now,
		};

		// Run Standard Webhooks challenge verification if secret is provided and not skipped
		if (secret && !params.skipVerification) {
			await this.verifyWebhookHandshake(callbackUrl, secret, subId);
		}

		if (this.sql) {
			try {
				this.sql.exec(
					`INSERT INTO mcp_subscriptions (id, callback_url, secret, stream_id, filter_task_id, filter_correlation_id, cursor, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET callback_url = excluded.callback_url, secret = excluded.secret, stream_id = excluded.stream_id, filter_task_id = excluded.filter_task_id, filter_correlation_id = excluded.filter_correlation_id, cursor = excluded.cursor`,
					subId,
					callbackUrl,
					secret ?? null,
					streamId ?? null,
					filter?.taskId ? String(filter.taskId) : null,
					filter?.correlationId ? String(filter.correlationId) : null,
					params.cursor ?? null,
					now,
				);
			} catch (e) {
				console.error('[flue:events] Failed to save subscription in SQLite:', e);
			}
		} else {
			this.subscriptions.set(subId, subscription);
		}

		// Replay past events if cursor or fromRevision was specified
		this.replayPastEvents(subscription, params.cursor, params.fromRevision);

		// Refresh before 24 hours
		const refreshBefore = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
		return { subscription, refreshBefore };
	}

	private replayPastEvents(
		sub: EventSubscription,
		cursor?: string,
		fromRevision?: number,
	): void {
		const replay = async () => {
			let eventsToReplay: ElectricEvent[] = [];
			if (this.sql) {
				try {
					let query = `SELECT * FROM mcp_events WHERE 1=1`;
					const bindings: unknown[] = [];
					if (sub.streamId) {
						query += ` AND stream_id = ?`;
						bindings.push(sub.streamId);
					}
					if (cursor) {
						query += ` AND cursor >= ?`;
						bindings.push(cursor);
					}
					query += ` ORDER BY cursor ASC`;
					const rows = this.sql.exec(query, ...bindings).toArray();
					eventsToReplay = rows.map((r) => ({
						eventId: String(r.event_id),
						streamId: String(r.stream_id),
						name: String(r.name),
						cursor: String(r.cursor),
						timestamp: String(r.timestamp),
						data: r.data ? JSON.parse(String(r.data)) : null,
					}));
				} catch {
					// continue
				}
			} else {
				const stream = sub.streamId
					? this.streams.get(sub.streamId) ?? []
					: Array.from(this.streams.values()).flat();

				eventsToReplay = stream.filter((e) => {
					if (cursor && e.cursor < cursor) return false;
					return true;
				});
			}

			// Filter by task/correlation if applicable
			for (const evt of eventsToReplay) {
				const data = (evt.data && typeof evt.data === 'object' ? evt.data : {}) as Record<
					string,
					unknown
				>;
				if (sub.filter?.taskId && data.taskId !== sub.filter.taskId) continue;
				if (sub.filter?.correlationId && data.correlationId !== sub.filter.correlationId) continue;
				if (fromRevision !== undefined && typeof data.revision === 'number' && data.revision < fromRevision) {
					continue;
				}
				await this.deliverEvent(sub, evt);
			}
		};

		if (this.ctx?.waitUntil) {
			this.ctx.waitUntil(replay());
		} else {
			void replay();
		}
	}

	/**
	 * Unsubscribe an active webhook subscription.
	 */
	unsubscribe(subscriptionId: string): boolean {
		if (this.sql) {
			try {
				const rows = this.sql
					.exec(`SELECT id FROM mcp_subscriptions WHERE id = ?`, subscriptionId)
					.toArray();
				if (!rows[0]) return false;
				this.sql.exec(`DELETE FROM mcp_subscriptions WHERE id = ?`, subscriptionId);
				return true;
			} catch {
				return false;
			}
		}
		return this.subscriptions.delete(subscriptionId);
	}

	getSubscription(subscriptionId: string): EventSubscription | undefined {
		if (this.sql) {
			try {
				const rows = this.sql
					.exec(`SELECT * FROM mcp_subscriptions WHERE id = ?`, subscriptionId)
					.toArray();
				const r = rows[0];
				if (!r) return undefined;
				return {
					id: String(r.id),
					callbackUrl: String(r.callback_url),
					secret: r.secret ? String(r.secret) : undefined,
					streamId: r.stream_id ? String(r.stream_id) : undefined,
					filter:
						r.filter_task_id || r.filter_correlation_id
							? {
									taskId: r.filter_task_id ? String(r.filter_task_id) : undefined,
									correlationId: r.filter_correlation_id
										? String(r.filter_correlation_id)
										: undefined,
								}
							: undefined,
					cursor: r.cursor ? String(r.cursor) : undefined,
					createdAt: String(r.created_at),
				};
			} catch {
				return undefined;
			}
		}
		return this.subscriptions.get(subscriptionId);
	}

	listSubscriptions(): EventSubscription[] {
		if (this.sql) {
			try {
				const rows = this.sql.exec(`SELECT * FROM mcp_subscriptions`).toArray();
				return rows.map((r) => ({
					id: String(r.id),
					callbackUrl: String(r.callback_url),
					secret: r.secret ? String(r.secret) : undefined,
					streamId: r.stream_id ? String(r.stream_id) : undefined,
					filter:
						r.filter_task_id || r.filter_correlation_id
							? {
									taskId: r.filter_task_id ? String(r.filter_task_id) : undefined,
									correlationId: r.filter_correlation_id
										? String(r.filter_correlation_id)
										: undefined,
								}
							: undefined,
					cursor: r.cursor ? String(r.cursor) : undefined,
					createdAt: String(r.created_at),
				}));
			} catch {
				return [];
			}
		}
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

		const signature = await signStandardWebhook(secret, msgId, timestamp, payload);

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

	// --------------------------------------------------------------------------
	// Core Fallback Resources (eventstream://)
	// --------------------------------------------------------------------------

	/**
	 * Read eventstream://head resource.
	 */
	readHeadResource(streamId: string): { content: string; mimeType: string } {
		const headCursor = this.getHeadCursor(streamId);
		const payload = {
			streamId,
			headCursor,
			updatedAt: new Date().toISOString(),
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
