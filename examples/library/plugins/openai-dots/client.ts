/**
 * Fabric Knowledge Library Client for OpenAI Dots (GPT-6 Astra)
 * Supports MCP 2.0 JSON-RPC, MCP Events, and HMAC Webhook Verification.
 */

export interface FabricLibraryConfig {
	baseUrl?: string;
	secret?: string;
}

export interface TaskSubmissionParams {
	type: 'curate' | 'synthesize' | 'research' | 'rebuild_index';
	payload: Record<string, unknown>;
	correlationId?: string;
}

export interface TaskRecord {
	id: string;
	correlationId?: string;
	type: string;
	status: 'queued' | 'running' | 'completed' | 'failed' | 'input_required' | 'cancelled';
	revision: number;
	summary?: string;
	resultReference?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

export interface TaskResult {
	taskId: string;
	resultId: string;
	status: string;
	summary: string;
	sources: Array<{ title?: string; url?: string; nativeId?: string }>;
	versions: { model: string; schema: string; protocol: string };
	limitations: string[];
	artifacts: string[];
	content: string;
	acknowledged: boolean;
	acknowledgedAt?: string;
	completedAt: string;
}

export class FabricLibraryClient {
	private readonly baseUrl: string;
	private readonly secret?: string;

	constructor(config: FabricLibraryConfig = {}) {
		this.baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? 'https://library.nymphai.workers.dev';
		this.secret = config.secret;
	}

	/**
	 * Fast edge search for technical stories and concepts.
	 */
	async search(query: string, type?: 'all' | 'stories' | 'concepts'): Promise<unknown> {
		return this.callTool('search', { query, type });
	}

	/**
	 * Fetch raw OKF markdown notes from the vault.
	 */
	async fetch(path: string): Promise<string> {
		const res = await this.callTool('fetch', { path });
		return typeof res === 'string' ? res : JSON.stringify(res);
	}

	/**
	 * Submit an asynchronous task to DO SQLite.
	 */
	async submitTask(params: TaskSubmissionParams): Promise<TaskRecord> {
		const res = await this.callTool('submit_task', {
			task_type: params.type,
			payload: params.payload,
			correlation_id: params.correlationId,
		});
		return typeof res === 'string' ? JSON.parse(res) : res;
	}

	/**
	 * Inspect durable task status.
	 */
	async getTask(taskId: string): Promise<TaskRecord | null> {
		const res = await this.rpc('tools/call', {
			name: 'get_task',
			arguments: { task_id: taskId },
		});
		const content = res?.content?.[0]?.text;
		return content ? JSON.parse(content) : null;
	}

	/**
	 * Retrieve completed durable result.
	 */
	async getResult(taskId: string): Promise<TaskResult | null> {
		const res = await this.rpc('tools/call', {
			name: 'get_result',
			arguments: { task_id: taskId },
		});
		const content = res?.content?.[0]?.text;
		return content ? JSON.parse(content) : null;
	}

	/**
	 * Acknowledge processing of a result.
	 */
	async acknowledgeResult(taskId: string, receipt?: unknown): Promise<boolean> {
		const res = await this.callTool('acknowledge_result', {
			task_id: taskId,
			receipt,
		});
		const parsed = typeof res === 'string' ? JSON.parse(res) : res;
		return Boolean(parsed?.acknowledged);
	}

	/**
	 * Register an event subscription before going idle.
	 */
	async subscribe(params: {
		callbackUrl: string;
		secret?: string;
		filter?: { taskId?: string; correlationId?: string };
	}): Promise<{ id: string; refreshBefore: string; cursor: string | null; truncated: boolean }> {
		return this.rpc('events/subscribe', {
			callbackUrl: params.callbackUrl,
			secret: params.secret ?? this.secret,
			filter: params.filter,
		});
	}

	/**
	 * Verify HMAC SHA-256 signature on an incoming wake callback.
	 */
	static async verifyWebhookSignature(
		secret: string,
		payload: string,
		signatureHeader: string,
	): Promise<boolean> {
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
		return `sha256=${hex}` === signatureHeader;
	}

	private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
		const res = await this.rpc('tools/call', { name, arguments: args });
		const text = res?.content?.[0]?.text;
		if (res?.isError) {
			throw new Error(`Tool ${name} error: ${text}`);
		}
		return text;
	}

	private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
		const response = await fetch(`${this.baseUrl}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: crypto.randomUUID().slice(0, 8),
				method,
				params,
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
		}

		const data = (await response.json()) as { result?: any; error?: { message: string } };
		if (data.error) {
			throw new Error(`RPC error: ${data.error.message}`);
		}
		return data.result;
	}
}
