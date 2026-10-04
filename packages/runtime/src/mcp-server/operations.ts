/**
 * Durable OperationStore and Tasks / job:// projections.
 *
 * Flue implements a single internal asynchronous Operation model.
 * It projects to:
 * - Native Tasks extension when client capability 'tasks' is active
 * - Durable job:// Resources + flue.job.cancel / flue.job.respond tools when core-only
 *
 * Supports SQLite backing (via ctx.storage.sql) and in-memory test fallback.
 *
 * Reference: docs/mcp-capability-projection.md § 9
 */

import type { DurableObjectStateLike, OperationPort, SqlStorageLike } from './ports.ts';
import type { CapabilityResult, McpInputRequest, Operation } from './types.ts';

export type OperationListener = (operation: Operation) => void;

export interface OperationStoreOptions {
	sql?: SqlStorageLike;
	ctx?: DurableObjectStateLike;
}

export class OperationStore implements OperationPort {
	private readonly operations = new Map<string, Operation>();
	private readonly listeners = new Set<OperationListener>();

	private readonly sql?: SqlStorageLike;
	private readonly ctx?: DurableObjectStateLike;

	constructor(options?: OperationStoreOptions) {
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
				capability_id TEXT NOT NULL,
				status TEXT NOT NULL,
				revision INTEGER NOT NULL,
				summary TEXT,
				payload TEXT,
				result TEXT,
				error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`);
			this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_tasks_status ON mcp_tasks(status)`);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_mcp_tasks_correlation ON mcp_tasks(correlation_id)`,
			);
		} catch (error) {
			console.error('[flue:operations] Failed to initialize SQLite schema', error);
		}
	}

	/**
	 * Create a new Operation in 'queued' or 'running' state.
	 */
	createOperation(params: {
		capabilityId: string;
		payload?: Record<string, unknown>;
		initialSummary?: string;
		state?: Operation['state'];
		correlationId?: string;
	}): Operation {
		const operationId = `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const now = new Date().toISOString();
		const state = params.state ?? 'running';
		const summary =
			params.initialSummary ?? `Operation ${operationId} started for ${params.capabilityId}`;

		const op: Operation = {
			operationId,
			capabilityId: params.capabilityId,
			state,
			revision: 1,
			summary,
			payload: params.payload,
			createdAt: now,
			updatedAt: now,
		};

		if (this.sql) {
			try {
				this.sql.exec(
					`INSERT INTO mcp_tasks (id, correlation_id, capability_id, status, revision, summary, payload, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					operationId,
					params.correlationId ?? null,
					params.capabilityId,
					state,
					1,
					summary,
					params.payload ? JSON.stringify(params.payload) : null,
					now,
					now,
				);
			} catch (e) {
				console.error('[flue:operations] Failed to insert task into SQLite:', e);
			}
		} else {
			this.operations.set(operationId, op);
		}

		this.notifyListeners(op);
		return { ...op };
	}

	/**
	 * Retrieve operation by ID.
	 */
	getOperation(operationId: string): Operation | undefined {
		if (this.sql) {
			try {
				const rows = this.sql.exec(`SELECT * FROM mcp_tasks WHERE id = ?`, operationId).toArray();
				const r = rows[0];
				if (!r) return undefined;
				return {
					operationId: String(r.id),
					capabilityId: String(r.capability_id),
					state: r.status as Operation['state'],
					revision: Number(r.revision),
					summary: r.summary ? String(r.summary) : undefined,
					payload: r.payload
						? (JSON.parse(String(r.payload)) as Record<string, unknown>)
						: undefined,
					result: r.result ? (JSON.parse(String(r.result)) as CapabilityResult) : undefined,
					error: r.error ? (JSON.parse(String(r.error)) as Operation['error']) : undefined,
					createdAt: String(r.created_at),
					updatedAt: String(r.updated_at),
				};
			} catch {
				return undefined;
			}
		}

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
			inputRequests?: Array<McpInputRequest>;
		},
	): Operation {
		const existing = this.getOperation(operationId);
		if (!existing) {
			throw new Error(`Operation '${operationId}' not found.`);
		}

		const revision = existing.revision + 1;
		const updatedAt = new Date().toISOString();
		const state = update.state ?? existing.state;
		const summary = update.summary ?? existing.summary;
		const result = update.result !== undefined ? update.result : existing.result;
		const error = update.error !== undefined ? update.error : existing.error;
		const inputRequests =
			update.inputRequests !== undefined ? update.inputRequests : existing.inputRequests;

		const op: Operation = {
			...existing,
			revision,
			updatedAt,
			state,
			summary,
			result,
			error,
			inputRequests,
		};

		if (this.sql) {
			try {
				this.sql.exec(
					`UPDATE mcp_tasks SET status = ?, revision = ?, summary = ?, result = ?, error = ?, updated_at = ? WHERE id = ?`,
					state,
					revision,
					summary ?? null,
					result ? JSON.stringify(result) : null,
					error ? JSON.stringify(error) : null,
					updatedAt,
					operationId,
				);
			} catch (e) {
				console.error('[flue:operations] Failed to update task in SQLite:', e);
			}
		} else {
			this.operations.set(operationId, op);
		}

		this.notifyListeners(op);
		return { ...op };
	}

	/**
	 * Cancel an operation.
	 */
	cancelOperation(operationId: string, reason = 'Cancelled by caller'): boolean {
		const existing = this.getOperation(operationId);
		if (!existing) return false;
		if (
			existing.state === 'completed' ||
			existing.state === 'failed' ||
			existing.state === 'cancelled'
		) {
			return false;
		}

		this.updateOperation(operationId, {
			state: 'cancelled',
			summary: reason,
		});
		return true;
	}

	/**
	 * Respond to an operation in input_required state.
	 */
	respondOperation(
		operationId: string,
		_response: { inputId?: string; input: unknown },
	): Operation {
		const op = this.getOperation(operationId);
		if (!op) {
			throw new Error(`Operation '${operationId}' not found.`);
		}
		if (op.state !== 'input_required') {
			throw new Error(
				`Operation '${operationId}' is in state '${op.state}', not 'input_required'.`,
			);
		}

		return this.updateOperation(operationId, {
			state: 'running',
			summary: 'Received response for input request. Resuming execution.',
			inputRequests: undefined,
		});
	}

	/**
	 * List active and historical operations.
	 */
	listOperations(filter?: { state?: Operation['state']; capabilityId?: string }): Operation[] {
		if (this.sql) {
			try {
				let query = `SELECT * FROM mcp_tasks WHERE 1=1`;
				const bindings: unknown[] = [];
				if (filter?.state) {
					query += ` AND status = ?`;
					bindings.push(filter.state);
				}
				if (filter?.capabilityId) {
					query += ` AND capability_id = ?`;
					bindings.push(filter.capabilityId);
				}
				query += ` ORDER BY updated_at DESC`;
				const rows = this.sql.exec(query, ...bindings).toArray();
				return rows.map((r) => ({
					operationId: String(r.id),
					capabilityId: String(r.capability_id),
					state: r.status as Operation['state'],
					revision: Number(r.revision),
					summary: r.summary ? String(r.summary) : undefined,
					payload: r.payload
						? (JSON.parse(String(r.payload)) as Record<string, unknown>)
						: undefined,
					result: r.result ? (JSON.parse(String(r.result)) as CapabilityResult) : undefined,
					error: r.error ? (JSON.parse(String(r.error)) as Operation['error']) : undefined,
					createdAt: String(r.created_at),
					updatedAt: String(r.updated_at),
				}));
			} catch {
				return [];
			}
		}

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
