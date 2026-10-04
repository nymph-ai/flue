/**
 * Canonical Ports for Flue MCP Capability Projection.
 *
 * Defines unified port interfaces for:
 * - Operations / Tasks state and execution
 * - Event log / Durable streams
 * - Subscriptions and Webhook deliveries
 * - Audit logging and SQL storage adapters
 *
 * These ports decouple the MCP wire protocol projections from physical storage,
 * allowing identical behavior across in-memory test doubles and Cloudflare Durable Objects.
 */

import type {
	AuditLogEntry,
	CapabilityResult,
	ElectricEvent,
	EventSubscription,
	McpInputRequest,
	Operation,
	WebhookDeliveryRecord,
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

/**
 * Canonical port representing execution authority for asynchronous operations/tasks.
 *
 * OperationPort is the execution authority, not a passive task-record store:
 * submitting an operation transfers execution ownership to the underlying engine
 * (e.g. AgentDO via AgentOperationService, or durable task services).
 * The MCP projection plane does not execute shadow runs or schedule local background
 * runners once submitted to OperationPort.
 */
export interface OperationPort {
	createOperation(params: {
		capabilityId: string;
		payload?: Record<string, unknown>;
		initialSummary?: string;
		state?: Operation['state'];
		correlationId?: string;
	}): Promise<Operation> | Operation;

	getOperation(operationId: string): Promise<Operation | undefined> | Operation | undefined;

	updateOperation(
		operationId: string,
		update: {
			state?: Operation['state'];
			summary?: string;
			result?: CapabilityResult;
			error?: { code: string; message: string; details?: unknown };
			inputRequests?: McpInputRequest[];
		},
	): Promise<Operation> | Operation;

	cancelOperation(operationId: string, reason?: string): Promise<boolean> | boolean;

	respondOperation(
		operationId: string,
		response: { inputId?: string; input: unknown },
	): Promise<Operation> | Operation;

	listOperations(filter?: {
		state?: Operation['state'];
		capabilityId?: string;
	}): Promise<Operation[]> | Operation[];

	onOperationUpdated?(listener: (op: Operation) => void): () => void;
	readJobResource?(
		jobUri: string,
	): Promise<{ content: string; mimeType: string }> | { content: string; mimeType: string };
	projectJobFallbackResult?(op: Operation): CapabilityResult;
}

export interface SubscriptionStorePort {
	saveSubscription(sub: EventSubscription): Promise<void> | void;
	getSubscription(
		id: string,
	): Promise<EventSubscription | undefined> | EventSubscription | undefined;
	deleteSubscription(id: string): Promise<boolean> | boolean;
	listSubscriptions(): Promise<EventSubscription[]> | EventSubscription[];
}

export interface EventPort {
	appendEvent(
		streamId: string,
		name: string,
		data: unknown,
		cursor?: string,
	): Promise<ElectricEvent> | ElectricEvent;

	readEvents(
		streamId: string,
		afterCursor?: string,
		limit?: number,
	):
		| Promise<{ events: ElectricEvent[]; nextCursor: string | null; headCursor: string | null }>
		| { events: ElectricEvent[]; nextCursor: string | null; headCursor: string | null };

	getHeadCursor(streamId: string): Promise<string | null> | string | null;

	listStreams(): Promise<string[]> | string[];

	readHeadResource?(
		streamId: string,
	): Promise<{ content: string; mimeType: string }> | { content: string; mimeType: string };
	readAfterResource?(
		streamId: string,
		afterCursor: string,
		limit?: number,
	): Promise<{ content: string; mimeType: string }> | { content: string; mimeType: string };

	saveSubscription?(sub: EventSubscription): Promise<void> | void;
	getSubscription?(
		id: string,
	): Promise<EventSubscription | undefined> | EventSubscription | undefined;
	deleteSubscription?(id: string): Promise<boolean> | boolean;
	listSubscriptions?(): Promise<EventSubscription[]> | EventSubscription[];
	getDeliveryLogs?(): Promise<readonly WebhookDeliveryRecord[]> | readonly WebhookDeliveryRecord[];
	getAuditLogs?(limit?: number): Promise<AuditLogEntry[]> | AuditLogEntry[];
	drainSubscriptions?(streamId: string, headCursor?: string): Promise<void> | void;
	processDoorbell?(streamId: string, headCursor?: string): Promise<void> | void;
}

export interface McpAuditLogPort {
	logAudit(category: string, details: Record<string, unknown>): Promise<void> | void;
	getAuditLogs(limit?: number): Promise<AuditLogEntry[]> | AuditLogEntry[];
}

/**
 * Agent-facing operation service interface exposed by an AgentDO via DO RPC.
 * Flue maps onto Pi's public abstractions inside the AgentDO without the generic
 * MCP projection reaching through into Pi Durable internals.
 */
export interface AgentOperationService {
	submitTask(params: {
		capabilityId: string;
		payload?: Record<string, unknown>;
		correlationId?: string;
	}): Promise<{ taskId: string; state: Operation['state'] }>;

	getTask(taskId: string): Promise<Operation | undefined>;

	cancelTask(taskId: string, reason?: string): Promise<boolean>;

	respondTask(taskId: string, response: { inputId?: string; input: unknown }): Promise<Operation>;

	listTasks(filter?: { state?: Operation['state'] }): Promise<Operation[]>;
}

/**
 * Cloudflare adapter that connects MCP projection's OperationPort to an AgentDO's
 * AgentOperationService via DO RPC, preserving the invariant that generic MCP code
 * never reaches into Pi Durable internals.
 */
export class CloudflareAgentOperationPort implements OperationPort {
	constructor(private readonly agentService: AgentOperationService) {}

	async createOperation(params: {
		capabilityId: string;
		payload?: Record<string, unknown>;
		initialSummary?: string;
		state?: Operation['state'];
		correlationId?: string;
	}): Promise<Operation> {
		const res = await this.agentService.submitTask({
			capabilityId: params.capabilityId,
			payload: params.payload,
			correlationId: params.correlationId,
		});
		return {
			operationId: res.taskId,
			capabilityId: params.capabilityId,
			state: res.state,
			revision: 1,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			summary: params.initialSummary,
			payload: params.payload,
		};
	}

	async getOperation(operationId: string): Promise<Operation | undefined> {
		return await this.agentService.getTask(operationId);
	}

	async updateOperation(
		operationId: string,
		_update: {
			state?: Operation['state'];
			summary?: string;
			result?: CapabilityResult;
			error?: { code: string; message: string; details?: unknown };
			inputRequests?: McpInputRequest[];
		},
	): Promise<Operation> {
		const current = await this.agentService.getTask(operationId);
		if (!current) throw new Error(`Task '${operationId}' not found on AgentDO.`);
		return current;
	}

	async cancelOperation(operationId: string, reason?: string): Promise<boolean> {
		return await this.agentService.cancelTask(operationId, reason);
	}

	async respondOperation(
		operationId: string,
		response: { inputId?: string; input: unknown },
	): Promise<Operation> {
		return await this.agentService.respondTask(operationId, response);
	}

	async listOperations(filter?: {
		state?: Operation['state'];
		capabilityId?: string;
	}): Promise<Operation[]> {
		const tasks = await this.agentService.listTasks({ state: filter?.state });
		if (filter?.capabilityId) {
			return tasks.filter((t) => t.capabilityId === filter.capabilityId);
		}
		return tasks;
	}

	async readJobResource(jobUri: string): Promise<{ content: string; mimeType: string }> {
		const match = jobUri.match(/^job:\/\/([^/?#]+)/);
		if (!match) throw new Error(`Invalid job URI: ${jobUri}`);
		const jobId = match[1] ?? '';
		const op = await this.getOperation(jobId);
		if (!op) throw new Error(`Job '${jobId}' not found.`);
		return {
			content: JSON.stringify(op, null, 2),
			mimeType: 'application/json',
		};
	}

	projectJobFallbackResult(op: Operation): CapabilityResult {
		const jobUri = `job://${op.operationId}`;
		return {
			resultType: 'complete',
			content: [
				{
					type: 'text',
					text: `Operation '${op.operationId}' is ${op.state}. Observable via ${jobUri}`,
				},
			],
			structuredContent: {
				state: op.state,
				jobId: op.operationId,
				jobUri,
				summary: op.summary,
				revision: op.revision,
				createdAt: op.createdAt,
				updatedAt: op.updatedAt,
			},
			resourceLinks: [jobUri],
			operationId: op.operationId,
		};
	}
}
