/**
 * Durable OperationStore and Tasks / job:// projections.
 *
 * Flue implements a single internal asynchronous Operation model.
 * It projects to:
 * - Native Tasks extension when client capability 'tasks' is active
 * - Durable job:// Resources + flue.job.cancel / flue.job.respond tools when core-only
 *
 * Reference: docs/mcp-capability-projection.md § 9
 */

import type { CapabilityResult, Operation } from './types.ts';

export type OperationListener = (operation: Operation) => void;

export class OperationStore {
	private readonly operations = new Map<string, Operation>();
	private readonly listeners = new Set<OperationListener>();

	/**
	 * Create a new Operation in 'queued' or 'running' state.
	 */
	createOperation(params: {
		capabilityId: string;
		payload?: Record<string, unknown>;
		initialSummary?: string;
		state?: Operation['state'];
	}): Operation {
		const operationId = `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const now = new Date().toISOString();

		const op: Operation = {
			operationId,
			capabilityId: params.capabilityId,
			state: params.state ?? 'running',
			revision: 1,
			summary: params.initialSummary ?? `Operation ${operationId} started for ${params.capabilityId}`,
			payload: params.payload,
			createdAt: now,
			updatedAt: now,
		};

		this.operations.set(operationId, op);
		this.notifyListeners(op);
		return { ...op };
	}

	/**
	 * Retrieve operation by ID.
	 */
	getOperation(operationId: string): Operation | undefined {
		const op = this.operations.get(operationId);
		return op ? { ...op } : undefined;
	}

	/**
	 * Update an existing operation's status, progress, result, or error.
	 */
	updateOperation(
		operationId: string,
		update: {
			state?: Operation['state'];
			summary?: string;
			result?: CapabilityResult;
			error?: { code: string; message: string; details?: unknown };
			inputRequests?: Array<{ id: string; prompt: string; schema?: Record<string, unknown> }>;
		},
	): Operation {
		const op = this.operations.get(operationId);
		if (!op) {
			throw new Error(`Operation '${operationId}' not found.`);
		}

		op.revision += 1;
		op.updatedAt = new Date().toISOString();
		if (update.state) op.state = update.state;
		if (update.summary) op.summary = update.summary;
		if (update.result !== undefined) op.result = update.result;
		if (update.error !== undefined) op.error = update.error;
		if (update.inputRequests !== undefined) op.inputRequests = update.inputRequests;

		this.notifyListeners(op);
		return { ...op };
	}

	/**
	 * Cancel an operation.
	 */
	cancelOperation(operationId: string, reason = 'Cancelled by caller'): boolean {
		const op = this.operations.get(operationId);
		if (!op) return false;
		if (op.state === 'completed' || op.state === 'failed' || op.state === 'cancelled') {
			return false;
		}

		op.state = 'cancelled';
		op.revision += 1;
		op.updatedAt = new Date().toISOString();
		op.summary = reason;
		op.cancellation = {
			reason,
			cancelledAt: op.updatedAt,
		};

		this.notifyListeners(op);
		return true;
	}

	/**
	 * Respond to an operation in input_required state.
	 */
	respondOperation(
		operationId: string,
		_response: { inputId?: string; input: unknown },
	): Operation {
		const op = this.operations.get(operationId);
		if (!op) {
			throw new Error(`Operation '${operationId}' not found.`);
		}
		if (op.state !== 'input_required') {
			throw new Error(`Operation '${operationId}' is in state '${op.state}', not 'input_required'.`);
		}

		op.state = 'running';
		op.revision += 1;
		op.updatedAt = new Date().toISOString();
		op.summary = `Received response for input request. Resuming execution.`;
		op.inputRequests = undefined;

		this.notifyListeners(op);
		return { ...op };
	}

	/**
	 * List active and historical operations.
	 */
	listOperations(filter?: { state?: Operation['state']; capabilityId?: string }): Operation[] {
		const result: Operation[] = [];
		for (const op of this.operations.values()) {
			if (filter?.state && op.state !== filter.state) continue;
			if (filter?.capabilityId && op.capabilityId !== filter.capabilityId) continue;
			result.push({ ...op });
		}
		return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/**
	 * Read job:// URI as an MCP resource.
	 */
	readJobResource(jobUri: string): { content: string; mimeType: string } {
		const match = jobUri.match(/^job:\/\/([^/?#]+)/);
		if (!match) {
			throw new Error(`Invalid job URI: ${jobUri}`);
		}
		const jobId = match[1] ?? '';
		const op = this.getOperation(jobId);
		if (!op) {
			throw new Error(`Job '${jobId}' not found.`);
		}

		return {
			content: JSON.stringify(op, null, 2),
			mimeType: 'application/json',
		};
	}

	/**
	 * Project an operation into a completed MCP tool result with job:// fallback.
	 */
	projectJobFallbackResult(op: Operation): CapabilityResult {
		const jobUri = `job://${op.operationId}`;
		return {
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

	/**
	 * Subscribe to operation state changes.
	 */
	onOperationUpdated(listener: OperationListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notifyListeners(op: Operation): void {
		for (const listener of this.listeners) {
			try {
				listener({ ...op });
			} catch {
				// ignore listener errors
			}
		}
	}
}
