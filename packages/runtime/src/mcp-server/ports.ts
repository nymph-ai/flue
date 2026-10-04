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
}

export interface McpAuditLogPort {
	logAudit(category: string, details: Record<string, unknown>): Promise<void> | void;
	getAuditLogs(limit?: number): Promise<AuditLogEntry[]> | AuditLogEntry[];
}
