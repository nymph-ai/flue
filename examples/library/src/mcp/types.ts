/**
 * Types for Model Context Protocol (MCP) 2.0 (2026-07-28) with MCP Events.
 * Designed for OpenAI Dots, AI coworkers, and asynchronous durable execution.
 */

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'input_required' | 'cancelled';

export interface TaskRecord {
	id: string; // e.g. "task_01j9a8b..."
	correlationId?: string; // Client's conversation/thread/message ID
	type: string; // 'curate' | 'synthesize' | 'research' | 'rebuild_index'
	status: TaskStatus;
	revision: number; // Incremented on every state change
	payload: Record<string, unknown>;
	summary?: string;
	resultReference?: string; // e.g. "/mcp/results/task_xxx"
	error?: string;
	inputRequired?: {
		prompt: string;
		schema?: Record<string, unknown>;
	};
	createdAt: string;
	updatedAt: string;
}

export interface TaskResult {
	taskId: string;
	resultId: string;
	status: 'completed' | 'failed';
	summary: string;
	sources: Array<{ title?: string; url: string; nativeId?: string }>;
	versions: {
		model: string; // e.g. "meta/muse-spark-1.3-contributor"
		schema: string; // "okf/v1"
		protocol: string; // "mcp/2026-07-28"
		workerRevision?: string;
	};
	limitations: string[];
	artifacts: string[]; // Vault paths e.g. ["stories/hn-49930412.md", "concepts/bpf-fault.md"]
	content: string; // Primary synthesized markdown or data
	acknowledged: boolean;
	acknowledgedAt?: string;
	acknowledgementReceipt?: unknown;
	completedAt: string;
}

export interface TaskChangedEvent {
	event: 'task_changed';
	eventId: string; // Unique UUID for event deduplication
	taskId: string;
	correlationId?: string;
	revision: number;
	cursor?: string;
	status: TaskStatus;
	summary: string;
	resultReference?: string;
	error?: string;
	inputRequired?: {
		prompt: string;
		schema?: Record<string, unknown>;
	};
	timestamp: string;
}

export interface SubscriptionRecord {
	id: string; // "sub_xxx"
	callbackUrl: string;
	secret?: string; // Shared secret for HMAC-SHA256 signature
	filter?: {
		taskId?: string;
		correlationId?: string;
	};
	createdAt: string;
}

export interface DeliveryRecord {
	id: string;
	eventId: string;
	taskId: string;
	revision: number;
	subscriptionId: string;
	status: 'delivered' | 'failed';
	statusCode?: number;
	error?: string;
	attempt: number;
	timestamp: string;
}
