/**
 * Durable Task Store and MCP Events Engine.
 * Supports asynchronous job submission, durable results, delivery tracking,
 * scoped subscriptions, HMAC signing, event replay, and explicit acknowledgements.
 * Backed by Cloudflare Durable Object SQLite (ctx.storage.sql) with in-memory fallback.
 */
import { liveModel } from '../model.ts';
import { getOrCreateVault } from '../wiki/routes.ts';
import { LibraryVault } from '../wiki/storage.ts';
import type { OKFStoryNote } from '../wiki/types.ts';
import type {
	DeliveryRecord,
	SubscriptionRecord,
	TaskChangedEvent,
	TaskRecord,
	TaskResult,
	TaskStatus,
} from './types.ts';

export interface SqlCursorLike {
	toArray(): Record<string, unknown>[];
}

export interface SqlStorageLike {
	exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

export interface DurableObjectStateLike {
	storage?: { sql?: SqlStorageLike };
	waitUntil?(promise: Promise<unknown>): void;
}

export interface TaskStoreOptions {
	sql?: SqlStorageLike;
	ctx?: DurableObjectStateLike;
}

export async function signPayload(secret: string, payload: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
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
	return expected === signatureHeader;
}

export class TaskStore {
	private readonly tasks = new Map<string, TaskRecord>();
	private readonly results = new Map<string, TaskResult>();
	private readonly subscriptions = new Map<string, SubscriptionRecord>();
	private readonly events: TaskChangedEvent[] = [];
	private readonly deliveryRecords: DeliveryRecord[] = [];
	private readonly getVault: () => LibraryVault;
	private readonly sql?: SqlStorageLike;
	private readonly ctx?: DurableObjectStateLike;

	constructor(
		getVault: () => LibraryVault = getOrCreateVault,
		options?: TaskStoreOptions,
	) {
		this.getVault = getVault;
		this.sql = options?.sql;
		this.ctx = options?.ctx;
		if (this.sql) {
			this.initSchema();
		}
	}

	private initSchema(): void {
		if (!this.sql) return;
		try {
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_tasks (
				id TEXT PRIMARY KEY,
				correlation_id TEXT,
				type TEXT NOT NULL,
				status TEXT NOT NULL,
				revision INTEGER NOT NULL,
				summary TEXT,
				payload TEXT NOT NULL,
				result_reference TEXT,
				error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`);
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_results (
				task_id TEXT PRIMARY KEY,
				result_id TEXT NOT NULL,
				status TEXT NOT NULL,
				summary TEXT NOT NULL,
				sources TEXT NOT NULL,
				versions TEXT NOT NULL,
				limitations TEXT NOT NULL,
				artifacts TEXT NOT NULL,
				content TEXT,
				acknowledged INTEGER NOT NULL DEFAULT 0,
				acknowledged_at TEXT,
				acknowledgement_receipt TEXT,
				completed_at TEXT NOT NULL
			)`);
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_subscriptions (
				id TEXT PRIMARY KEY,
				callback_url TEXT NOT NULL,
				secret TEXT,
				filter_task_id TEXT,
				filter_correlation_id TEXT,
				created_at TEXT NOT NULL
			)`);
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_events (
				event_id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				correlation_id TEXT,
				event TEXT NOT NULL,
				revision INTEGER NOT NULL,
				status TEXT NOT NULL,
				summary TEXT NOT NULL,
				result_reference TEXT,
				error TEXT,
				timestamp TEXT NOT NULL
			)`);
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_deliveries (
				id TEXT PRIMARY KEY,
				event_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				subscription_id TEXT NOT NULL,
				status TEXT NOT NULL,
				status_code INTEGER,
				error TEXT,
				attempt INTEGER NOT NULL DEFAULT 1,
				timestamp TEXT NOT NULL
			)`);
			this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_events_task ON mcp_events(task_id, revision)`);
			this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_events_correlation ON mcp_events(correlation_id)`);
			this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_deliveries_task ON mcp_deliveries(task_id)`);

			// Resume any pending or interrupted tasks from prior boot
			const pending = this.sql
				.exec(`SELECT id FROM mcp_tasks WHERE status IN ('queued', 'running')`)
				.toArray();
			for (const row of pending) {
				const taskId = String(row.id);
				this.scheduleExecution(taskId);
			}
		} catch (error) {
			console.error('[flue:mcp] failed to initialize SQLite schema', error);
		}
	}

	private scheduleExecution(taskId: string): void {
		const run = async () => {
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			await this.executeTask(taskId);
		};
		const promise = run();
		if (this.ctx?.waitUntil) {
			this.ctx.waitUntil(promise);
		}
	}

	/**
	 * Submits a new task, immediately assigning a durable ID and returning in 'queued' state.
	 */
	submitTask(params: {
		type: string;
		payload: Record<string, unknown>;
		correlationId?: string;
	}): TaskRecord {
		const taskId = `task_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const now = new Date().toISOString();
		const summary = `Task ${taskId} queued for execution (${params.type}).`;

		const task: TaskRecord = {
			id: taskId,
			correlationId: params.correlationId,
			type: params.type,
			status: 'queued',
			revision: 1,
			summary,
			payload: params.payload,
			createdAt: now,
			updatedAt: now,
		};

		if (this.sql) {
			this.sql.exec(
				`INSERT INTO mcp_tasks (id, correlation_id, type, status, revision, summary, payload, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				taskId,
				params.correlationId ?? null,
				params.type,
				'queued',
				1,
				summary,
				JSON.stringify(params.payload),
				now,
				now,
			);
		} else {
			this.tasks.set(taskId, task);
		}

		// Record initial state transition in background
		this.recordEvent({
			event: 'task_changed',
			eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
			taskId,
			correlationId: task.correlationId,
			revision: task.revision,
			status: 'queued',
			summary,
			timestamp: now,
		});

		// Trigger background execution asynchronously
		this.scheduleExecution(taskId);

		return { ...task };
	}

	getTask(taskId: string): TaskRecord | null {
		if (this.sql) {
			const rows = this.sql.exec(`SELECT * FROM mcp_tasks WHERE id = ?`, taskId).toArray();
			const r = rows[0];
			if (!r) return null;
			return {
				id: String(r.id),
				correlationId: r.correlation_id ? String(r.correlation_id) : undefined,
				type: String(r.type),
				status: r.status as TaskStatus,
				revision: Number(r.revision),
				summary: r.summary ? String(r.summary) : undefined,
				payload: r.payload ? (JSON.parse(String(r.payload)) as Record<string, unknown>) : {},
				resultReference: r.result_reference ? String(r.result_reference) : undefined,
				error: r.error ? String(r.error) : undefined,
				createdAt: String(r.created_at),
				updatedAt: String(r.updated_at),
			};
		}
		return this.tasks.get(taskId) ?? null;
	}

	getResult(taskId: string): TaskResult | null {
		if (this.sql) {
			const rows = this.sql.exec(`SELECT * FROM mcp_results WHERE task_id = ?`, taskId).toArray();
			const r = rows[0];
			if (!r) return null;
			return {
				taskId: String(r.task_id),
				resultId: String(r.result_id),
				status: 'completed',
				summary: String(r.summary),
				sources: r.sources ? (JSON.parse(String(r.sources)) as TaskResult['sources']) : [],
				versions: r.versions
					? (JSON.parse(String(r.versions)) as TaskResult['versions'])
					: { model: '', schema: '', protocol: '' },
				limitations: r.limitations ? (JSON.parse(String(r.limitations)) as string[]) : [],
				artifacts: r.artifacts ? (JSON.parse(String(r.artifacts)) as string[]) : [],
				content: r.content !== null && r.content !== undefined ? String(r.content) : '',
				acknowledged: Boolean(r.acknowledged),
				acknowledgedAt: r.acknowledged_at ? String(r.acknowledged_at) : undefined,
				acknowledgementReceipt: r.acknowledgement_receipt
					? JSON.parse(String(r.acknowledgement_receipt))
					: undefined,
				completedAt: String(r.completed_at),
			};
		}
		return this.results.get(taskId) ?? null;
	}

	/**
	 * Cancels a task if still queued or running.
	 */
	cancelTask(taskId: string, reason = 'Cancelled by caller'): boolean {
		if (this.sql) {
			const rows = this.sql.exec(`SELECT * FROM mcp_tasks WHERE id = ?`, taskId).toArray();
			const r = rows[0];
			if (!r) return false;
			const status = String(r.status);
			if (status === 'completed' || status === 'failed' || status === 'cancelled') {
				return false;
			}
			const revision = Number(r.revision) + 1;
			const now = new Date().toISOString();
			this.sql.exec(
				`UPDATE mcp_tasks SET status = 'cancelled', revision = ?, summary = ?, updated_at = ? WHERE id = ?`,
				revision,
				reason,
				now,
				taskId,
			);
			this.recordEvent({
				event: 'task_changed',
				eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
				taskId,
				correlationId: r.correlation_id ? String(r.correlation_id) : undefined,
				revision,
				status: 'cancelled',
				summary: reason,
				timestamp: now,
			});
			return true;
		}

		const task = this.tasks.get(taskId);
		if (!task) return false;
		if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
			return false;
		}

		task.status = 'cancelled';
		task.revision += 1;
		task.updatedAt = new Date().toISOString();
		task.summary = reason;

		this.recordEvent({
			event: 'task_changed',
			eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
			taskId: task.id,
			correlationId: task.correlationId,
			revision: task.revision,
			status: 'cancelled',
			summary: reason,
			timestamp: task.updatedAt,
		});

		return true;
	}

	/**
	 * Explicitly acknowledges receipt and processing of a result.
	 */
	acknowledgeResult(taskId: string, receipt?: unknown): boolean {
		if (this.sql) {
			const rows = this.sql.exec(`SELECT task_id FROM mcp_results WHERE task_id = ?`, taskId).toArray();
			if (!rows[0]) return false;
			const now = new Date().toISOString();
			const rcpt = JSON.stringify(receipt ?? { clientAcknowledged: true });
			this.sql.exec(
				`UPDATE mcp_results SET acknowledged = 1, acknowledged_at = ?, acknowledgement_receipt = ? WHERE task_id = ?`,
				now,
				rcpt,
				taskId,
			);
			return true;
		}

		const result = this.results.get(taskId);
		if (!result) return false;

		result.acknowledged = true;
		result.acknowledgedAt = new Date().toISOString();
		result.acknowledgementReceipt = receipt ?? { clientAcknowledged: true };
		return true;
	}

	/**
	 * Establishes a scoped subscription and immediately replays past matching events.
	 */
	async subscribe(params: {
		callbackUrl: string;
		secret?: string;
		filter?: { taskId?: string; correlationId?: string };
		fromRevision?: number;
		cursor?: string;
	}): Promise<{
		subscription: SubscriptionRecord;
		replayedEvents: TaskChangedEvent[];
		cursor: string;
	}> {
		const subId = `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const now = new Date().toISOString();
		const subscription: SubscriptionRecord = {
			id: subId,
			callbackUrl: params.callbackUrl,
			secret: params.secret,
			filter: params.filter,
			createdAt: now,
		};

		let fromRev = params.fromRevision;
		if (fromRev === undefined && params.cursor !== undefined) {
			const parsed = parseInt(String(params.cursor), 10);
			if (!Number.isNaN(parsed)) {
				fromRev = parsed;
			}
		}

		let matching: TaskChangedEvent[] = [];

		if (this.sql) {
			this.sql.exec(
				`INSERT INTO mcp_subscriptions (id, callback_url, secret, filter_task_id, filter_correlation_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				subId,
				params.callbackUrl,
				params.secret ?? null,
				params.filter?.taskId ?? null,
				params.filter?.correlationId ?? null,
				now,
			);

			let query = `SELECT * FROM mcp_events WHERE 1=1`;
			const bindings: unknown[] = [];
			if (params.filter?.taskId) {
				query += ` AND task_id = ?`;
				bindings.push(params.filter.taskId);
			}
			if (params.filter?.correlationId) {
				query += ` AND correlation_id = ?`;
				bindings.push(params.filter.correlationId);
			}
			if (typeof fromRev === 'number') {
				query += ` AND revision >= ?`;
				bindings.push(fromRev);
			}
			query += ` ORDER BY timestamp ASC`;
			const rows = this.sql.exec(query, ...bindings).toArray();
			matching = rows.map((r) => ({
				event: 'task_changed',
				eventId: String(r.event_id),
				taskId: String(r.task_id),
				correlationId: r.correlation_id ? String(r.correlation_id) : undefined,
				revision: Number(r.revision),
				cursor: String(r.revision),
				status: r.status as TaskStatus,
				summary: String(r.summary),
				resultReference: r.result_reference ? String(r.result_reference) : undefined,
				error: r.error ? String(r.error) : undefined,
				timestamp: String(r.timestamp),
			}));
		} else {
			this.subscriptions.set(subId, subscription);
			matching = this.events
				.filter((evt) => {
					if (params.filter?.taskId && evt.taskId !== params.filter.taskId) return false;
					if (params.filter?.correlationId && evt.correlationId !== params.filter.correlationId)
						return false;
					if (fromRev !== undefined && evt.revision < fromRev) return false;
					return true;
				})
				.map((evt) => ({
					...evt,
					cursor: evt.cursor ?? String(evt.revision),
				}));
		}

		for (const evt of matching) {
			const p = this.deliverEvent(subscription, evt);
			if (this.ctx?.waitUntil) this.ctx.waitUntil(p);
			else void p;
		}

		let cursor = '0';
		const lastEvent = matching[matching.length - 1];
		if (lastEvent) {
			cursor = String(lastEvent.revision);
		} else {
			cursor = String(this.getLatestRevision(params.filter));
		}

		return { subscription, replayedEvents: matching, cursor };
	}

	getLatestRevision(filter?: { taskId?: string; correlationId?: string }): number {
		if (this.sql) {
			let query = `SELECT MAX(revision) as max_rev FROM mcp_events WHERE 1=1`;
			const bindings: unknown[] = [];
			if (filter?.taskId) {
				query += ` AND task_id = ?`;
				bindings.push(filter.taskId);
			}
			if (filter?.correlationId) {
				query += ` AND correlation_id = ?`;
				bindings.push(filter.correlationId);
			}
			const rows = this.sql.exec(query, ...bindings).toArray();
			const maxRev = rows[0]?.max_rev;
			return typeof maxRev === 'number' ? maxRev : maxRev ? Number(maxRev) : 0;
		}

		let maxRev = 0;
		for (const evt of this.events) {
			if (filter?.taskId && evt.taskId !== filter.taskId) continue;
			if (filter?.correlationId && evt.correlationId !== filter.correlationId) continue;
			if (evt.revision > maxRev) maxRev = evt.revision;
		}
		return maxRev;
	}

	unsubscribe(subscriptionId: string): boolean {
		if (this.sql) {
			const rows = this.sql
				.exec(`SELECT id FROM mcp_subscriptions WHERE id = ?`, subscriptionId)
				.toArray();
			if (!rows[0]) return false;
			this.sql.exec(`DELETE FROM mcp_subscriptions WHERE id = ?`, subscriptionId);
			return true;
		}
		return this.subscriptions.delete(subscriptionId);
	}

	listEvents(filter?: {
		taskId?: string;
		correlationId?: string;
		fromRevision?: number;
		cursor?: string;
	}): TaskChangedEvent[] {
		let fromRev = filter?.fromRevision;
		if (fromRev === undefined && filter?.cursor !== undefined) {
			const parsed = parseInt(String(filter.cursor), 10);
			if (!Number.isNaN(parsed)) {
				fromRev = parsed;
			}
		}

		if (this.sql) {
			let query = `SELECT * FROM mcp_events WHERE 1=1`;
			const bindings: unknown[] = [];
			if (filter?.taskId) {
				query += ` AND task_id = ?`;
				bindings.push(filter.taskId);
			}
			if (filter?.correlationId) {
				query += ` AND correlation_id = ?`;
				bindings.push(filter.correlationId);
			}
			if (typeof fromRev === 'number') {
				query += ` AND revision >= ?`;
				bindings.push(fromRev);
			}
			query += ` ORDER BY timestamp ASC`;
			const rows = this.sql.exec(query, ...bindings).toArray();
			return rows.map((r) => ({
				event: 'task_changed',
				eventId: String(r.event_id),
				taskId: String(r.task_id),
				correlationId: r.correlation_id ? String(r.correlation_id) : undefined,
				revision: Number(r.revision),
				cursor: String(r.revision),
				status: r.status as TaskStatus,
				summary: String(r.summary),
				resultReference: r.result_reference ? String(r.result_reference) : undefined,
				error: r.error ? String(r.error) : undefined,
				timestamp: String(r.timestamp),
			}));
		}

		return this.events
			.filter((evt) => {
				if (filter?.taskId && evt.taskId !== filter.taskId) return false;
				if (filter?.correlationId && evt.correlationId !== filter.correlationId) return false;
				if (fromRev !== undefined && evt.revision < fromRev) return false;
				return true;
			})
			.map((evt) => ({
				...evt,
				cursor: evt.cursor ?? String(evt.revision),
			}));
	}

	getDeliveryRecords(taskId?: string): DeliveryRecord[] {
		if (this.sql) {
			let query = `SELECT * FROM mcp_deliveries`;
			const bindings: unknown[] = [];
			if (taskId) {
				query += ` WHERE task_id = ?`;
				bindings.push(taskId);
			}
			query += ` ORDER BY timestamp ASC`;
			const rows = this.sql.exec(query, ...bindings).toArray();
			return rows.map((r) => ({
				id: String(r.id),
				eventId: String(r.event_id),
				taskId: String(r.task_id),
				revision: Number(r.revision),
				subscriptionId: String(r.subscription_id),
				status: r.status as 'delivered' | 'failed',
				statusCode: r.status_code !== null && r.status_code !== undefined ? Number(r.status_code) : undefined,
				error: r.error ? String(r.error) : undefined,
				attempt: Number(r.attempt ?? 1),
				timestamp: String(r.timestamp),
			}));
		}

		if (!taskId) return [...this.deliveryRecords];
		return this.deliveryRecords.filter((d) => d.taskId === taskId);
	}

	private recordEvent(event: TaskChangedEvent): void {
		if (!event.cursor) {
			event.cursor = String(event.revision);
		}

		if (this.sql) {
			this.sql.exec(
				`INSERT INTO mcp_events (event_id, task_id, correlation_id, event, revision, status, summary, result_reference, error, timestamp)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				event.eventId,
				event.taskId,
				event.correlationId ?? null,
				event.event,
				event.revision,
				event.status,
				event.summary,
				event.resultReference ?? null,
				event.error ?? null,
				event.timestamp,
			);

			const subRows = this.sql.exec(`SELECT * FROM mcp_subscriptions`).toArray();
			for (const r of subRows) {
				const filterTaskId = r.filter_task_id ? String(r.filter_task_id) : undefined;
				const filterCorrelationId = r.filter_correlation_id
					? String(r.filter_correlation_id)
					: undefined;
				if (filterTaskId && filterTaskId !== event.taskId) continue;
				if (filterCorrelationId && filterCorrelationId !== event.correlationId) continue;
				const sub: SubscriptionRecord = {
					id: String(r.id),
					callbackUrl: String(r.callback_url),
					secret: r.secret ? String(r.secret) : undefined,
					filter:
						filterTaskId || filterCorrelationId
							? { taskId: filterTaskId, correlationId: filterCorrelationId }
							: undefined,
					createdAt: String(r.created_at),
				};
				const p = this.deliverEvent(sub, event);
				if (this.ctx?.waitUntil) this.ctx.waitUntil(p);
				else void p;
			}
		} else {
			this.events.push(event);

			// Dispatch to all active subscriptions matching filter
			for (const sub of this.subscriptions.values()) {
				if (sub.filter?.taskId && sub.filter.taskId !== event.taskId) continue;
				if (sub.filter?.correlationId && sub.filter.correlationId !== event.correlationId)
					continue;
				const p = this.deliverEvent(sub, event);
				if (this.ctx?.waitUntil) this.ctx.waitUntil(p);
				else void p;
			}
		}
	}

	private async deliverEvent(sub: SubscriptionRecord, event: TaskChangedEvent): Promise<void> {
		const cursor = event.cursor ?? String(event.revision);
		const eventWithCursor: TaskChangedEvent = {
			...event,
			cursor,
		};
		const payloadString = JSON.stringify(eventWithCursor);
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'x-mcp-event-id': event.eventId,
			'x-mcp-task-id': event.taskId,
			'x-mcp-revision': String(event.revision),
			'x-mcp-cursor': cursor,
			'x-mcp-event-type': event.event,
		};

		if (sub.secret) {
			headers['x-mcp-event-signature'] = await signPayload(sub.secret, payloadString);
		}

		const deliveryId = `del_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const now = new Date().toISOString();

		try {
			const res = await fetch(sub.callbackUrl, {
				method: 'POST',
				headers,
				body: payloadString,
			});

			if (this.sql) {
				this.sql.exec(
					`INSERT INTO mcp_deliveries (id, event_id, task_id, revision, subscription_id, status, status_code, attempt, timestamp)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					deliveryId,
					event.eventId,
					event.taskId,
					event.revision,
					sub.id,
					res.ok ? 'delivered' : 'failed',
					res.status,
					1,
					now,
				);
			} else {
				this.deliveryRecords.push({
					id: deliveryId,
					eventId: event.eventId,
					taskId: event.taskId,
					revision: event.revision,
					subscriptionId: sub.id,
					status: res.ok ? 'delivered' : 'failed',
					statusCode: res.status,
					attempt: 1,
					timestamp: now,
				});
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			if (this.sql) {
				this.sql.exec(
					`INSERT INTO mcp_deliveries (id, event_id, task_id, revision, subscription_id, status, error, attempt, timestamp)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					deliveryId,
					event.eventId,
					event.taskId,
					event.revision,
					sub.id,
					'failed',
					errMsg,
					1,
					now,
				);
			} else {
				this.deliveryRecords.push({
					id: deliveryId,
					eventId: event.eventId,
					taskId: event.taskId,
					revision: event.revision,
					subscriptionId: sub.id,
					status: 'failed',
					error: errMsg,
					attempt: 1,
					timestamp: now,
				});
			}
		}
	}

	private async executeTask(taskId: string): Promise<void> {
		let task: TaskRecord | null = null;
		if (this.sql) {
			const rows = this.sql.exec(`SELECT * FROM mcp_tasks WHERE id = ?`, taskId).toArray();
			const r = rows[0];
			if (!r || r.status === 'cancelled') return;
			task = {
				id: String(r.id),
				correlationId: r.correlation_id ? String(r.correlation_id) : undefined,
				type: String(r.type),
				status: r.status as TaskStatus,
				revision: Number(r.revision),
				summary: r.summary ? String(r.summary) : undefined,
				payload: r.payload ? (JSON.parse(String(r.payload)) as Record<string, unknown>) : {},
				resultReference: r.result_reference ? String(r.result_reference) : undefined,
				createdAt: String(r.created_at),
				updatedAt: String(r.updated_at),
			};
		} else {
			task = this.tasks.get(taskId) ?? null;
			if (!task || task.status === 'cancelled') return;
		}

		// Transition to running
		task.status = 'running';
		task.revision += 1;
		task.updatedAt = new Date().toISOString();
		task.summary = `Task ${taskId} execution started.`;

		if (this.sql) {
			this.sql.exec(
				`UPDATE mcp_tasks SET status = 'running', revision = ?, summary = ?, updated_at = ? WHERE id = ?`,
				task.revision,
				task.summary,
				task.updatedAt,
				taskId,
			);
		}

		this.recordEvent({
			event: 'task_changed',
			eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
			taskId: task.id,
			correlationId: task.correlationId,
			revision: task.revision,
			status: 'running',
			summary: task.summary,
			timestamp: task.updatedAt,
		});

		const vault = this.getVault();

		try {
			if (task.type === 'curate') {
				const p = task.payload;
				const nativeId = String(p.native_id ?? crypto.randomUUID().slice(0, 8));
				const title = String(p.title ?? 'Untitled Story');
				const url = String(p.url ?? 'https://news.ycombinator.com');
				const topics = Array.isArray(p.topics) ? (p.topics as string[]) : ['Systems'];
				const concepts = Array.isArray(p.concepts) ? (p.concepts as string[]) : [];

				const story: OKFStoryNote = {
					schema_version: 'okf/v1',
					id: `hn-${nativeId}`,
					type: 'story',
					title,
					resource: url,
					source: 'hackernews',
					native_id: nativeId,
					timestamp: new Date().toISOString(),
					curator: 'curator',
					curator_model: liveModel(),
					significance_score:
						typeof p.significance_score === 'number' ? p.significance_score : 0.92,
					topics,
					concepts,
					tags: topics.map((t) => `#${t.toLowerCase().replace(/\s+/g, '-')}`),
					summary: String(p.summary ?? ''),
					significance: String(p.significance ?? ''),
					curatorNotes: String(p.curatorNotes ?? 'Curated via MCP task submission.'),
					discussionUrl: `https://news.ycombinator.com/item?id=${nativeId}`,
					by: p.by ? String(p.by) : undefined,
					score: typeof p.score === 'number' ? p.score : undefined,
				};

				const path = await vault.saveStoryNote(story);
				const content = (await vault.getNote(path)) ?? '';

				const result: TaskResult = {
					taskId,
					resultId: `res_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
					status: 'completed',
					summary: `Curated "${title}" into ${path} with ${concepts.length} concept links.`,
					sources: [{ title, url, nativeId }],
					versions: {
						model: liveModel(),
						schema: 'okf/v1',
						protocol: 'mcp/2026-07-28',
					},
					limitations: [
						'Automated synthesis by Muse Spark 1.3 Contributor',
						`Significance score: ${story.significance_score}`,
					],
					artifacts: [path, ...concepts.map((c) => `concepts/${c.replace(/[[\]]/g, '')}.md`)],
					content,
					acknowledged: false,
					completedAt: new Date().toISOString(),
				};

				if (this.sql) {
					this.sql.exec(
						`INSERT INTO mcp_results (task_id, result_id, status, summary, sources, versions, limitations, artifacts, content, acknowledged, completed_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						taskId,
						result.resultId,
						result.status,
						result.summary,
						JSON.stringify(result.sources),
						JSON.stringify(result.versions),
						JSON.stringify(result.limitations),
						JSON.stringify(result.artifacts),
						result.content,
						0,
						result.completedAt,
					);
				} else {
					this.results.set(taskId, result);
				}

				// Update task to completed
				task.status = 'completed';
				task.revision += 1;
				task.summary = result.summary;
				task.resultReference = `/mcp/results/${taskId}`;
				task.updatedAt = result.completedAt;

				if (this.sql) {
					this.sql.exec(
						`UPDATE mcp_tasks SET status = 'completed', revision = ?, summary = ?, result_reference = ?, updated_at = ? WHERE id = ?`,
						task.revision,
						task.summary,
						task.resultReference,
						task.updatedAt,
						taskId,
					);
				}

				this.recordEvent({
					event: 'task_changed',
					eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
					taskId: task.id,
					correlationId: task.correlationId,
					revision: task.revision,
					status: 'completed',
					summary: result.summary,
					resultReference: task.resultReference,
					timestamp: task.updatedAt,
				});
			} else if (task.type === 'research' || task.type === 'search') {
				const query = String(task.payload.query ?? '');
				const allPaths = await vault.listNotes();
				const matches: Array<{ path: string; excerpt: string }> = [];

				for (const path of allPaths) {
					const text = await vault.getNote(path);
					if (text && text.toLowerCase().includes(query.toLowerCase())) {
						matches.push({ path, excerpt: text.slice(0, 200) });
					}
				}

				const result: TaskResult = {
					taskId,
					resultId: `res_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
					status: 'completed',
					summary: `Found ${matches.length} matching vault notes for "${query}".`,
					sources: matches.map((m) => ({ url: m.path })),
					versions: {
						model: liveModel(),
						schema: 'okf/v1',
						protocol: 'mcp/2026-07-28',
					},
					limitations: ['Exact substring search across markdown notes'],
					artifacts: matches.map((m) => m.path),
					content: JSON.stringify(matches, null, 2),
					acknowledged: false,
					completedAt: new Date().toISOString(),
				};

				if (this.sql) {
					this.sql.exec(
						`INSERT INTO mcp_results (task_id, result_id, status, summary, sources, versions, limitations, artifacts, content, acknowledged, completed_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						taskId,
						result.resultId,
						result.status,
						result.summary,
						JSON.stringify(result.sources),
						JSON.stringify(result.versions),
						JSON.stringify(result.limitations),
						JSON.stringify(result.artifacts),
						result.content,
						0,
						result.completedAt,
					);
				} else {
					this.results.set(taskId, result);
				}

				task.status = 'completed';
				task.revision += 1;
				task.summary = result.summary;
				task.resultReference = `/mcp/results/${taskId}`;
				task.updatedAt = result.completedAt;

				if (this.sql) {
					this.sql.exec(
						`UPDATE mcp_tasks SET status = 'completed', revision = ?, summary = ?, result_reference = ?, updated_at = ? WHERE id = ?`,
						task.revision,
						task.summary,
						task.resultReference,
						task.updatedAt,
						taskId,
					);
				}

				this.recordEvent({
					event: 'task_changed',
					eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
					taskId: task.id,
					correlationId: task.correlationId,
					revision: task.revision,
					status: 'completed',
					summary: result.summary,
					resultReference: task.resultReference,
					timestamp: task.updatedAt,
				});
			} else {
				throw new Error(`Unsupported task type: ${task.type}`);
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			task.status = 'failed';
			task.revision += 1;
			task.error = errMsg;
			task.summary = `Execution failed: ${errMsg}`;
			task.updatedAt = new Date().toISOString();

			if (this.sql) {
				this.sql.exec(
					`UPDATE mcp_tasks SET status = 'failed', revision = ?, error = ?, summary = ?, updated_at = ? WHERE id = ?`,
					task.revision,
					task.error,
					task.summary,
					task.updatedAt,
					taskId,
				);
			}

			this.recordEvent({
				event: 'task_changed',
				eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
				taskId: task.id,
				correlationId: task.correlationId,
				revision: task.revision,
				status: 'failed',
				summary: task.summary,
				error: errMsg,
				timestamp: task.updatedAt,
			});
		}
	}
}

let defaultTaskStore: TaskStore | null = null;

export function getOrCreateTaskStore(
	getVault?: () => LibraryVault,
	options?: TaskStoreOptions,
): TaskStore {
	if (!defaultTaskStore) {
		defaultTaskStore = new TaskStore(getVault, options);
	}
	return defaultTaskStore;
}

/**
 * Base extension for Durable Objects that exposes MCP stateful methods over RPC,
 * backed by the object's SQLite storage (this.ctx.storage.sql).
 */
export function mcpBase<TBase extends new (...args: any[]) => any>(Base: TBase): TBase {
	return class McpCuratorAgent extends Base {
		private mcpTaskStore: TaskStore | null = null;
		public ctx: any;
		public env: any;

		constructor(...args: any[]) {
			super(...args);
			this.ctx = args[0];
			this.env = args[1];
		}

		private getMcpStore(): TaskStore {
			if (!this.mcpTaskStore) {
				const ctx = this.ctx ?? (this as any).ctx;
				const env = this.env ?? (this as any).env;
				this.mcpTaskStore = new TaskStore(
					() => getOrCreateVault(env),
					{ sql: ctx?.storage?.sql, ctx },
				);
			}
			return this.mcpTaskStore;
		}

		async submitMcpTask(params: {
			type: string;
			payload: Record<string, unknown>;
			correlationId?: string;
		}): Promise<TaskRecord> {
			return this.getMcpStore().submitTask(params);
		}

		async getMcpTask(taskId: string): Promise<TaskRecord | null> {
			return this.getMcpStore().getTask(taskId);
		}

		async getMcpResult(taskId: string): Promise<TaskResult | null> {
			return this.getMcpStore().getResult(taskId);
		}

		async cancelMcpTask(taskId: string, reason?: string): Promise<boolean> {
			return this.getMcpStore().cancelTask(taskId, reason);
		}

		async acknowledgeMcpResult(taskId: string, receipt?: unknown): Promise<boolean> {
			return this.getMcpStore().acknowledgeResult(taskId, receipt);
		}

		async subscribeMcp(params: {
			callbackUrl: string;
			secret?: string;
			filter?: { taskId?: string; correlationId?: string };
			fromRevision?: number;
			cursor?: string;
		}): Promise<{ subscription: SubscriptionRecord; replayedEvents: TaskChangedEvent[]; cursor: string }> {
			return this.getMcpStore().subscribe(params);
		}

		async unsubscribeMcp(subscriptionId: string): Promise<boolean> {
			return this.getMcpStore().unsubscribe(subscriptionId);
		}

		async listMcpEvents(filter?: {
			taskId?: string;
			correlationId?: string;
			fromRevision?: number;
			cursor?: string;
		}): Promise<TaskChangedEvent[]> {
			return this.getMcpStore().listEvents(filter);
		}

		async getMcpDeliveries(taskId?: string): Promise<DeliveryRecord[]> {
			return this.getMcpStore().getDeliveryRecords(taskId);
		}
	} as unknown as TBase;
}
