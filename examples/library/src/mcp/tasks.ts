/**
 * Durable Task Store and MCP Events Engine.
 * Supports asynchronous job submission, durable results, delivery tracking,
 * scoped subscriptions, HMAC signing, event replay, and explicit acknowledgements.
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

export class TaskStore {
	private readonly tasks = new Map<string, TaskRecord>();
	private readonly results = new Map<string, TaskResult>();
	private readonly subscriptions = new Map<string, SubscriptionRecord>();
	private readonly events: TaskChangedEvent[] = [];
	private readonly deliveryRecords: DeliveryRecord[] = [];
	private readonly getVault: () => LibraryVault;

	constructor(getVault: () => LibraryVault = getOrCreateVault) {
		this.getVault = getVault;
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

		const task: TaskRecord = {
			id: taskId,
			correlationId: params.correlationId,
			type: params.type,
			status: 'queued',
			revision: 1,
			payload: params.payload,
			createdAt: now,
			updatedAt: now,
		};

		this.tasks.set(taskId, task);

		// Record initial state transition in background
		this.recordEvent({
			event: 'task_changed',
			eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
			taskId,
			correlationId: task.correlationId,
			revision: task.revision,
			status: 'queued',
			summary: `Task ${taskId} queued for execution (${task.type}).`,
			timestamp: now,
		});

		// Trigger background execution
		void this.executeTask(taskId);

		return task;
	}

	getTask(taskId: string): TaskRecord | null {
		return this.tasks.get(taskId) ?? null;
	}

	getResult(taskId: string): TaskResult | null {
		return this.results.get(taskId) ?? null;
	}

	/**
	 * Cancels a task if still queued or running.
	 */
	cancelTask(taskId: string, reason = 'Cancelled by caller'): boolean {
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
	}): Promise<{ subscription: SubscriptionRecord; replayedEvents: TaskChangedEvent[] }> {
		const subId = `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const subscription: SubscriptionRecord = {
			id: subId,
			callbackUrl: params.callbackUrl,
			secret: params.secret,
			filter: params.filter,
			createdAt: new Date().toISOString(),
		};

		this.subscriptions.set(subId, subscription);

		// Replay past events matching the filter
		const matching = this.events.filter((evt) => {
			if (params.filter?.taskId && evt.taskId !== params.filter.taskId) return false;
			if (params.filter?.correlationId && evt.correlationId !== params.filter.correlationId) return false;
			if (params.fromRevision !== undefined && evt.revision < params.fromRevision) return false;
			return true;
		});

		for (const evt of matching) {
			void this.deliverEvent(subscription, evt);
		}

		return { subscription, replayedEvents: matching };
	}

	unsubscribe(subscriptionId: string): boolean {
		return this.subscriptions.delete(subscriptionId);
	}

	listEvents(filter?: { taskId?: string; correlationId?: string; fromRevision?: number }): TaskChangedEvent[] {
		return this.events.filter((evt) => {
			if (filter?.taskId && evt.taskId !== filter.taskId) return false;
			if (filter?.correlationId && evt.correlationId !== filter.correlationId) return false;
			if (filter?.fromRevision !== undefined && evt.revision < filter.fromRevision) return false;
			return true;
		});
	}

	getDeliveryRecords(taskId?: string): DeliveryRecord[] {
		if (!taskId) return [...this.deliveryRecords];
		return this.deliveryRecords.filter((d) => d.taskId === taskId);
	}

	private recordEvent(event: TaskChangedEvent): void {
		this.events.push(event);

		// Dispatch to all active subscriptions matching filter
		for (const sub of this.subscriptions.values()) {
			if (sub.filter?.taskId && sub.filter.taskId !== event.taskId) continue;
			if (sub.filter?.correlationId && sub.filter.correlationId !== event.correlationId) continue;
			void this.deliverEvent(sub, event);
		}
	}

	private async deliverEvent(sub: SubscriptionRecord, event: TaskChangedEvent): Promise<void> {
		const payloadString = JSON.stringify(event);
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'x-mcp-event-id': event.eventId,
			'x-mcp-task-id': event.taskId,
			'x-mcp-revision': String(event.revision),
			'x-mcp-event-type': event.event,
		};

		if (sub.secret) {
			headers['x-mcp-event-signature'] = await signPayload(sub.secret, payloadString);
		}

		const deliveryId = `del_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		try {
			const res = await fetch(sub.callbackUrl, {
				method: 'POST',
				headers,
				body: payloadString,
			});

			this.deliveryRecords.push({
				id: deliveryId,
				eventId: event.eventId,
				taskId: event.taskId,
				revision: event.revision,
				subscriptionId: sub.id,
				status: res.ok ? 'delivered' : 'failed',
				statusCode: res.status,
				attempt: 1,
				timestamp: new Date().toISOString(),
			});
		} catch (err) {
			this.deliveryRecords.push({
				id: deliveryId,
				eventId: event.eventId,
				taskId: event.taskId,
				revision: event.revision,
				subscriptionId: sub.id,
				status: 'failed',
				error: err instanceof Error ? err.message : String(err),
				attempt: 1,
				timestamp: new Date().toISOString(),
			});
		}
	}

	private async executeTask(taskId: string): Promise<void> {
		const task = this.tasks.get(taskId);
		if (!task || task.status === 'cancelled') return;

		// Transition to running
		task.status = 'running';
		task.revision += 1;
		task.updatedAt = new Date().toISOString();

		this.recordEvent({
			event: 'task_changed',
			eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
			taskId: task.id,
			correlationId: task.correlationId,
			revision: task.revision,
			status: 'running',
			summary: `Task ${taskId} execution started.`,
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
					significance_score: typeof p.significance_score === 'number' ? p.significance_score : 0.92,
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

				this.results.set(taskId, result);

				// Update task to completed
				task.status = 'completed';
				task.revision += 1;
				task.summary = result.summary;
				task.resultReference = `/mcp/results/${taskId}`;
				task.updatedAt = result.completedAt;

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

				this.results.set(taskId, result);
				task.status = 'completed';
				task.revision += 1;
				task.summary = result.summary;
				task.resultReference = `/mcp/results/${taskId}`;
				task.updatedAt = result.completedAt;

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

export function getOrCreateTaskStore(getVault?: () => LibraryVault): TaskStore {
	if (!defaultTaskStore) {
		defaultTaskStore = new TaskStore(getVault);
	}
	return defaultTaskStore;
}
