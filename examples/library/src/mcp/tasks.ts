/**
 * Durable Task Store and MCP Events Engine.
 * Supports asynchronous job submission, durable results, delivery tracking,
 * scoped subscriptions, HMAC signing, event replay, and explicit acknowledgements.
 * Backed by Cloudflare Durable Object SQLite (ctx.storage.sql) with in-memory fallback.
 */
import { liveModel } from '../model.ts';
import { redactSecrets, secretFingerprint } from './redact.ts';
import { formatConceptNote, slugify } from '../wiki/okf.ts';
import { getOrCreateVault } from '../wiki/routes.ts';
import { LibraryVault } from '../wiki/storage.ts';
import type { OKFConceptNote, OKFStoryNote } from '../wiki/types.ts';
import type {
	DeliveryRecord,
	FabricDelivery,
	FabricMessageIn,
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

/** One of the Dot's Fabric tools, called as its proc through dots-host (fabric/DOTS.md D5). */
export type FabricCaller = (tool: 'send' | 'delegate' | 'query', args: Record<string, unknown>) => Promise<unknown>;

export interface TaskStoreOptions {
	sql?: SqlStorageLike;
	ctx?: DurableObjectStateLike;
	fabric?: FabricCaller;
}

/** The Dot's proc (fabric/DOTS.md D2). */
export const DOT_PROC = '/nymphai/dot-chatgpt';
/** How long a Fabric message's capability lets the Dot act (DOTS D7). */
export const CAPABILITY_TTL_MS = 7 * 86_400_000;
/** Calls one capability may make in an hour, and all capabilities in a day. */
export const CALLS_PER_CAPABILITY_HOUR = 30;
export const CALLS_PER_DAY = 300;

export class FabricRefusal extends Error {}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function randomHex(bytes: number): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

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

export async function deriveSubscriptionId(
	callbackUrl: string,
	eventName = 'task_changed',
	filter?: { taskId?: string; correlationId?: string },
): Promise<string> {
	const filterKey = `${filter?.taskId ?? ''}:${filter?.correlationId ?? ''}`;
	const key = `${eventName}:${callbackUrl}:${filterKey}`;
	const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
	const hex = Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.slice(0, 16)
		.join('');
	return `sub_${hex}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const enc = new TextEncoder();
	const aBytes = enc.encode(a);
	const bBytes = enc.encode(b);
	if (aBytes.length !== bBytes.length) return false;
	let mismatch = 0;
	for (let i = 0; i < aBytes.length; i++) {
		mismatch |= aBytes[i]! ^ bBytes[i]!;
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
		keyBytes,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signedContent = `${msgId}.${timestamp}.${payload}`;
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
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
	return constantTimeEqual(expected, signatureHeader);
}

export class TaskStore {
	private readonly tasks = new Map<string, TaskRecord>();
	private readonly results = new Map<string, TaskResult>();
	private readonly subscriptions = new Map<string, SubscriptionRecord>();
	private readonly events: TaskChangedEvent[] = [];
	private readonly deliveryRecords: DeliveryRecord[] = [];
	private readonly auditLogs: Array<{
		id: string;
		category: string;
		details: unknown;
		timestamp: string;
	}> = [];
	private readonly vaultFiles = new Map<string, string>();
	private readonly getVault: () => LibraryVault;
	private readonly sql?: SqlStorageLike;
	private readonly ctx?: DurableObjectStateLike;
	private readonly fabric?: FabricCaller;
	private readonly eventAudience = new Map<string, string>();
	private readonly fabricMessages = new Map<string, Record<string, unknown>>();
	private readonly fabricCalls: Array<{ capabilityHash: string; at: number }> = [];

	constructor(getVault: () => LibraryVault = getOrCreateVault, options?: TaskStoreOptions) {
		this.getVault = getVault;
		this.sql = options?.sql;
		this.ctx = options?.ctx;
		this.fabric = options?.fabric;
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
			this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_vault_files (
				path TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_mcp_events_task ON mcp_events(task_id, revision)`,
			);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_mcp_events_correlation ON mcp_events(correlation_id)`,
			);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_mcp_deliveries_task ON mcp_deliveries(task_id)`,
			);
			this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_vault_files_path ON mcp_vault_files(path)`);
			// An event with an audience goes to that one subscription only: a
			// Fabric message is the Dot's, never another subscriber's (DOTS D7).
			if (
				!this.sql
					.exec(`PRAGMA table_info(mcp_events)`)
					.toArray()
					.some((c) => c.name === 'audience')
			) {
				this.sql.exec(`ALTER TABLE mcp_events ADD COLUMN audience TEXT`);
			}
			this.sql.exec(`CREATE TABLE IF NOT EXISTS fabric_messages (
				message_id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				event_id TEXT NOT NULL,
				subscription_id TEXT NOT NULL,
				from_address TEXT NOT NULL,
				capability TEXT NOT NULL,
				capability_hash TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				delivered_at TEXT,
				replied_at TEXT,
				created_at TEXT NOT NULL
			)`);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_fabric_messages_capability ON fabric_messages(capability_hash)`,
			);
			this.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_fabric_messages_task ON fabric_messages(task_id)`,
			);
			this.sql.exec(`CREATE TABLE IF NOT EXISTS fabric_calls (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				capability_hash TEXT NOT NULL,
				tool TEXT NOT NULL,
				at TEXT NOT NULL
			)`);
			try {
				this.scrubStoredAuditSecrets();
			} catch (error) {
				console.error('[flue:mcp] audit secret scrub failed', error);
			}

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

	/**
	 * Audit rows written before redaction existed carry subscribers' delivery
	 * secrets in rawParams. Rewrite them once; the marker row makes it a no-op
	 * on every later boot.
	 */
	private scrubStoredAuditSecrets(): void {
		if (!this.sql) return;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		const marker = 'audit_secrets_redacted_v1';
		if (this.sql.exec(`SELECT key FROM mcp_meta WHERE key = ?`, marker).toArray()[0]) return;
		let rewritten = 0;
		for (const row of this.sql.exec(`SELECT id, details FROM mcp_audit_logs`).toArray()) {
			const before = String(row.details ?? '');
			let after = before;
			try {
				after = JSON.stringify(redactSecrets(JSON.parse(before)));
			} catch {
				after = JSON.stringify(redactSecrets(before));
			}
			if (after !== before) {
				this.sql.exec(`UPDATE mcp_audit_logs SET details = ? WHERE id = ?`, after, row.id);
				rewritten++;
			}
		}
		this.sql.exec(
			`INSERT INTO mcp_meta (key, value) VALUES (?, ?)`,
			marker,
			JSON.stringify({ at: new Date().toISOString(), rewritten }),
		);
	}

	/** Subscriptions as an operator may see them: never the secret, only its fingerprint. */
	async listSubscriptions(): Promise<
		Array<{
			id: string;
			callbackUrl: string;
			filter?: { taskId?: string; correlationId?: string };
			createdAt: string;
			lastSubscribedAt: string | null;
			secretFingerprint: string | null;
		}>
	> {
		const records: SubscriptionRecord[] = this.sql
			? this.sql
					.exec(`SELECT * FROM mcp_subscriptions ORDER BY created_at ASC`)
					.toArray()
					.map((r) => ({
						id: String(r.id),
						callbackUrl: String(r.callback_url),
						secret: r.secret ? String(r.secret) : undefined,
						filter:
							r.filter_task_id || r.filter_correlation_id
								? {
										taskId: r.filter_task_id ? String(r.filter_task_id) : undefined,
										correlationId: r.filter_correlation_id
											? String(r.filter_correlation_id)
											: undefined,
									}
								: undefined,
						createdAt: String(r.created_at),
					}))
			: [...this.subscriptions.values()];
		const out = [];
		for (const sub of records) {
			let lastSubscribedAt: string | null = null;
			if (this.sql) {
				const row = this.sql
					.exec(
						`SELECT MAX(timestamp) AS at FROM mcp_audit_logs WHERE category = 'events/subscribe:success' AND details LIKE ?`,
						`%"subId":"${sub.id}"%`,
					)
					.toArray()[0];
				lastSubscribedAt = row?.at ? String(row.at) : null;
			}
			out.push({
				id: sub.id,
				callbackUrl: redactSecrets(sub.callbackUrl),
				filter: sub.filter,
				createdAt: sub.createdAt,
				lastSubscribedAt,
				secretFingerprint: await secretFingerprint(sub.secret),
			});
		}
		return out;
	}

	logAudit(category: string, details: Record<string, unknown>): void {
		details = redactSecrets(details);
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

	getAuditLogs(
		limit = 50,
	): Array<{ id: string; category: string; details: unknown; timestamp: string }> {
		if (this.sql) {
			try {
				const rows = this.sql
					.exec(`SELECT * FROM mcp_audit_logs ORDER BY timestamp DESC LIMIT ?`, limit)
					.toArray();
				return rows.map((r) => ({
					id: String(r.id),
					category: String(r.category),
					details: r.details ? redactSecrets(JSON.parse(String(r.details))) : null,
					timestamp: String(r.timestamp),
				}));
			} catch {
				return [];
			}
		}
		return redactSecrets(this.auditLogs.slice(0, limit));
	}

	saveNote(path: string, content: string): void {
		const cleanPath = path.replace(/^\/+/, '');
		const now = new Date().toISOString();
		if (this.sql) {
			this.sql.exec(
				`INSERT INTO mcp_vault_files (path, content, updated_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
				cleanPath,
				content,
				now,
			);
		} else {
			this.vaultFiles.set(cleanPath, content);
		}
	}

	getNote(path: string): string | null {
		const cleanPath = path.replace(/^\/+/, '');
		if (this.sql) {
			const rows = this.sql
				.exec(`SELECT content FROM mcp_vault_files WHERE path = ?`, cleanPath)
				.toArray();
			const content = rows[0]?.content;
			if (content !== undefined && content !== null) {
				const strContent = String(content);
				if (cleanPath.startsWith('concepts/') && strContent.includes('type: story')) {
					// Invalid concept note caching story content: bypass to synthesize proper concept note
				} else {
					return strContent;
				}
			}

			// If looking for a concept, also check by slugified path in vault files
			if (cleanPath.startsWith('concepts/')) {
				const title = cleanPath.slice('concepts/'.length).replace(/\.md$/, '');
				const slugPath = `concepts/${slugify(title)}.md`;
				if (slugPath !== cleanPath) {
					const slugRows = this.sql
						.exec(`SELECT content FROM mcp_vault_files WHERE path = ?`, slugPath)
						.toArray();
					const slugContent = slugRows[0]?.content;
					if (slugContent !== undefined && slugContent !== null) {
						const strSlug = String(slugContent);
						if (!strSlug.includes('type: story')) {
							return strSlug;
						}
					}
				}
			}

			// Fallback: check mcp_results table for matching artifact
			let resultRows: Array<Record<string, unknown>> = [];
			if (cleanPath.startsWith('concepts/')) {
				resultRows = this.sql
					.exec(
						`SELECT content, artifacts, summary, completed_at FROM mcp_results WHERE artifacts LIKE '%concepts/%'`,
					)
					.toArray() as Array<Record<string, unknown>>;
			} else {
				resultRows = this.sql
					.exec(
						`SELECT content, artifacts, summary, completed_at FROM mcp_results WHERE artifacts LIKE ?`,
						`%${cleanPath}%`,
					)
					.toArray() as Array<Record<string, unknown>>;
			}

			for (const r of resultRows) {
				try {
					const artifacts = JSON.parse(String(r.artifacts)) as string[];
					if (!Array.isArray(artifacts)) continue;

					if (cleanPath.startsWith('stories/') && artifacts.includes(cleanPath)) {
						return String(r.content ?? '');
					}

					if (cleanPath.startsWith('concepts/')) {
						const targetTitle = cleanPath.slice('concepts/'.length).replace(/\.md$/, '');
						const targetSlug = slugify(targetTitle);

						const matchingArtifact = artifacts.find((a) => {
							if (a === cleanPath) return true;
							if (a.startsWith('concepts/')) {
								const aTitle = a.slice('concepts/'.length).replace(/\.md$/, '');
								return slugify(aTitle) === targetSlug;
							}
							return false;
						});

						if (matchingArtifact) {
							const conceptTitle = matchingArtifact.startsWith('concepts/')
								? matchingArtifact.slice('concepts/'.length).replace(/\.md$/, '')
								: targetTitle;
							const storyPath = artifacts.find((a) => a.startsWith('stories/')) ?? '';
							const storyId = storyPath.replace(/^stories\//, '').replace(/\.md$/, '');
							const summary = String(r.summary ?? '');
							const completedAt = String(r.completed_at || new Date().toISOString());
							const conceptNote: OKFConceptNote = {
								schema_version: 'okf/v1',
								id: targetSlug,
								type: 'concept',
								title: conceptTitle,
								first_observed: completedAt,
								last_updated: completedAt,
								curator: 'curator',
								tags: ['concept', targetSlug],
								description: `Core domain concept extracted from curated literature.`,
								relatedStories: storyId ? [{ id: storyId, title: summary }] : [],
							};
							const formatted = formatConceptNote(conceptNote);
							this.saveNote(cleanPath, formatted);
							this.saveNote(`concepts/${targetSlug}.md`, formatted);
							return formatted;
						}
					} else if (artifacts.includes(cleanPath)) {
						return String(r.content ?? '');
					}
				} catch {
					// continue
				}
			}
			return null;
		}

		if (this.vaultFiles.has(cleanPath)) {
			const str = this.vaultFiles.get(cleanPath)!;
			if (!cleanPath.startsWith('concepts/') || !str.includes('type: story')) {
				return str;
			}
		}

		if (cleanPath.startsWith('concepts/')) {
			const title = cleanPath.slice('concepts/'.length).replace(/\.md$/, '');
			const slugPath = `concepts/${slugify(title)}.md`;
			if (this.vaultFiles.has(slugPath)) {
				const str = this.vaultFiles.get(slugPath)!;
				if (!str.includes('type: story')) return str;
			}
		}

		for (const r of this.results.values()) {
			if (cleanPath.startsWith('stories/') && r.artifacts.includes(cleanPath)) {
				return r.content;
			}
			if (cleanPath.startsWith('concepts/')) {
				const targetTitle = cleanPath.slice('concepts/'.length).replace(/\.md$/, '');
				const targetSlug = slugify(targetTitle);
				const matchingArtifact = r.artifacts.find((a) => {
					if (a === cleanPath) return true;
					if (a.startsWith('concepts/')) {
						const aTitle = a.slice('concepts/'.length).replace(/\.md$/, '');
						return slugify(aTitle) === targetSlug;
					}
					return false;
				});

				if (matchingArtifact) {
					const conceptTitle = matchingArtifact.startsWith('concepts/')
						? matchingArtifact.slice('concepts/'.length).replace(/\.md$/, '')
						: targetTitle;
					const storyPath = r.artifacts.find((a) => a.startsWith('stories/')) ?? '';
					const storyId = storyPath.replace(/^stories\//, '').replace(/\.md$/, '');
					const conceptNote: OKFConceptNote = {
						schema_version: 'okf/v1',
						id: targetSlug,
						type: 'concept',
						title: conceptTitle,
						first_observed: r.completedAt,
						last_updated: r.completedAt,
						curator: 'curator',
						tags: ['concept', targetSlug],
						description: `Core domain concept extracted from curated literature.`,
						relatedStories: storyId ? [{ id: storyId, title: r.summary }] : [],
					};
					const formatted = formatConceptNote(conceptNote);
					this.vaultFiles.set(cleanPath, formatted);
					this.vaultFiles.set(`concepts/${targetSlug}.md`, formatted);
					return formatted;
				}
			} else if (r.artifacts.includes(cleanPath)) {
				return r.content;
			}
		}

		return null;
	}

	listNotes(prefix = ''): string[] {
		const rawPaths = new Set<string>();
		if (this.sql) {
			let query = `SELECT path FROM mcp_vault_files`;
			const bindings: unknown[] = [];
			if (prefix) {
				query += ` WHERE path LIKE ?`;
				bindings.push(`${prefix}%`);
			}
			const rows = this.sql.exec(query, ...bindings).toArray();
			for (const r of rows) {
				if (r.path) rawPaths.add(String(r.path));
			}

			// Also collect artifacts from mcp_results
			const resultRows = this.sql.exec(`SELECT artifacts FROM mcp_results`).toArray();
			for (const r of resultRows) {
				try {
					const artifacts = JSON.parse(String(r.artifacts)) as string[];
					if (Array.isArray(artifacts)) {
						for (const a of artifacts) {
							if (a.startsWith(prefix)) rawPaths.add(a);
						}
					}
				} catch {
					// continue
				}
			}
		} else {
			for (const p of this.vaultFiles.keys()) {
				if (p.startsWith(prefix)) rawPaths.add(p);
			}
			for (const r of this.results.values()) {
				for (const a of r.artifacts) {
					if (a.startsWith(prefix)) rawPaths.add(a);
				}
			}
		}

		// Canonicalize paths so concept notes don't duplicate (e.g. concepts/foo-bar.md vs concepts/Foo Bar.md)
		const canonicalPaths = new Set<string>();
		for (const p of rawPaths) {
			const clean = p.replace(/^\/+/, '');
			if (clean.startsWith('concepts/')) {
				const title = clean.slice('concepts/'.length).replace(/\.md$/, '');
				const canonical = `concepts/${slugify(title)}.md`;
				if (!prefix || canonical.startsWith(prefix)) {
					canonicalPaths.add(canonical);
				}
			} else {
				if (!prefix || clean.startsWith(prefix)) {
					canonicalPaths.add(clean);
				}
			}
		}

		return Array.from(canonicalPaths).sort();
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
			const rows = this.sql
				.exec(`SELECT task_id FROM mcp_results WHERE task_id = ?`, taskId)
				.toArray();
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
		subscriptionId?: string;
	}): Promise<{
		subscription: SubscriptionRecord;
		replayedEvents: TaskChangedEvent[];
		cursor: string;
	}> {
		let subId = params.subscriptionId;
		if (!subId) {
			const filterKey = `${params.filter?.taskId ?? ''}:${params.filter?.correlationId ?? ''}`;
			const key = `${params.callbackUrl}:${filterKey}`;
			const hashBytes = new Uint8Array(
				await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)),
			);
			const hash = Array.from(hashBytes)
				.map((b) => b.toString(16).padStart(2, '0'))
				.slice(0, 16)
				.join('');
			subId = `sub_${hash}`;
		}
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
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET callback_url = excluded.callback_url, secret = excluded.secret, filter_task_id = excluded.filter_task_id, filter_correlation_id = excluded.filter_correlation_id`,
				subId,
				params.callbackUrl,
				params.secret ?? null,
				params.filter?.taskId ?? null,
				params.filter?.correlationId ?? null,
				now,
			);

			let query = `SELECT * FROM mcp_events WHERE (audience IS NULL OR audience = ?)`;
			const bindings: unknown[] = [subId];
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
					const audience = this.eventAudience.get(evt.eventId);
					if (audience && audience !== subId) return false;
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
			const p = this.withFabricMessage(evt).then((e) => this.deliverEvent(subscription, e));
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
				statusCode:
					r.status_code !== null && r.status_code !== undefined ? Number(r.status_code) : undefined,
				error: r.error ? String(r.error) : undefined,
				attempt: Number(r.attempt ?? 1),
				timestamp: String(r.timestamp),
			}));
		}

		if (!taskId) return [...this.deliveryRecords];
		return this.deliveryRecords.filter((d) => d.taskId === taskId);
	}

	private recordEvent(event: TaskChangedEvent, audience?: string, dispatch = true): void {
		if (!event.cursor) {
			event.cursor = String(event.revision);
		}

		if (this.sql) {
			this.sql.exec(
				`INSERT INTO mcp_events (event_id, task_id, correlation_id, event, revision, status, summary, result_reference, error, timestamp, audience)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				audience ?? null,
			);
			if (!dispatch) return;

			const subRows = this.sql.exec(`SELECT * FROM mcp_subscriptions`).toArray();
			for (const r of subRows) {
				if (audience && String(r.id) !== audience) continue;
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
			if (audience) this.eventAudience.set(event.eventId, audience);
			if (!dispatch) return;

			// Dispatch to all active subscriptions matching filter
			for (const sub of this.subscriptions.values()) {
				if (audience && sub.id !== audience) continue;
				if (sub.filter?.taskId && sub.filter.taskId !== event.taskId) continue;
				if (sub.filter?.correlationId && sub.filter.correlationId !== event.correlationId) continue;
				const p = this.deliverEvent(sub, event);
				if (this.ctx?.waitUntil) this.ctx.waitUntil(p);
				else void p;
			}
		}
	}

	private async deliverEvent(
		sub: SubscriptionRecord,
		event: TaskChangedEvent,
	): Promise<{ ok: boolean; status?: number; error?: string }> {
		const cursor = event.cursor ?? String(event.revision);
		const eventData = {
			event: 'task_changed',
			eventId: event.eventId,
			taskId: event.taskId,
			correlationId: event.correlationId,
			revision: event.revision,
			cursor,
			status: event.status,
			summary: event.summary,
			resultReference: event.resultReference,
			error: event.error,
			timestamp: event.timestamp,
			...(event.fabricMessage ? { kind: 'fabric_message', fabricMessage: event.fabricMessage } : {}),
		};
		const eventEnvelope = {
			eventId: event.eventId,
			name: 'task_changed',
			timestamp: event.timestamp || new Date().toISOString(),
			data: eventData,
			cursor: cursor ?? null,
		};
		const payloadString = JSON.stringify(eventEnvelope);
		const timestampSeconds = Math.floor(Date.now() / 1000).toString();
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'webhook-id': event.eventId,
			'webhook-timestamp': timestampSeconds,
			'x-mcp-subscription-id': sub.id,
			'x-mcp-event-id': event.eventId,
			'x-mcp-task-id': event.taskId,
			'x-mcp-revision': String(event.revision),
			'x-mcp-cursor': cursor,
			'x-mcp-event-type': 'task_changed',
			'user-agent': 'NymphAI-Knowledge-Vault/2.0 (MCP 2026-07-28)',
		};

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
				console.error('[mcp:deliverEvent] Failed to sign payload:', signErr);
			}
		}

		const deliveryId = `del_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		const now = new Date().toISOString();

		this.logAudit('mcp:deliverEvent:attempt', {
			deliveryId,
			subId: sub.id,
			callbackUrl: sub.callbackUrl,
			eventId: event.eventId,
			taskId: event.taskId,
		});

		try {
			console.log(
				`[mcp:deliverEvent] Delivering event ${event.eventId} (status=${event.status}) to ${redactSecrets(sub.callbackUrl)}`,
			);
			const res = await fetch(sub.callbackUrl, {
				method: 'POST',
				headers,
				body: payloadString,
			});
			const resText = await res.text();
			console.log(
				`[mcp:deliverEvent] Delivery ${deliveryId} response: status=${res.status} body=${resText}`,
			);

			this.logAudit('mcp:deliverEvent:response', {
				deliveryId,
				subId: sub.id,
				callbackUrl: sub.callbackUrl,
				eventId: event.eventId,
				taskId: event.taskId,
				status: res.status,
				ok: res.ok,
				responseBody: resText.slice(0, 1000),
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
			return { ok: res.ok, status: res.status };
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.logAudit('mcp:deliverEvent:error', {
				deliveryId,
				subId: sub.id,
				callbackUrl: sub.callbackUrl,
				eventId: event.eventId,
				taskId: event.taskId,
				error: errMsg,
			});
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
			return { ok: false, error: errMsg };
		}
	}

	// ─── Fabric: the operator's Dot as a Fabric proc (fabric/DOTS.md) ─────────

	private subscriptionById(id: string): SubscriptionRecord | null {
		if (!this.sql) return this.subscriptions.get(id) ?? null;
		const r = this.sql.exec(`SELECT * FROM mcp_subscriptions WHERE id = ?`, id).toArray()[0];
		if (!r) return null;
		const taskId = r.filter_task_id ? String(r.filter_task_id) : undefined;
		const correlationId = r.filter_correlation_id ? String(r.filter_correlation_id) : undefined;
		return {
			id: String(r.id),
			callbackUrl: String(r.callback_url),
			secret: r.secret ? String(r.secret) : undefined,
			filter: taskId || correlationId ? { taskId, correlationId } : undefined,
			createdAt: String(r.created_at),
		};
	}

	private fabricMessageRow(where: 'message_id' | 'task_id' | 'capability_hash', value: string) {
		if (!this.sql) {
			for (const row of this.fabricMessages.values()) if (row[where] === value) return row;
			return null;
		}
		return (
			this.sql.exec(`SELECT * FROM fabric_messages WHERE ${where} = ?`, value).toArray()[0] ??
			null
		);
	}

	/** An event of a Fabric message's task carries the message to the Dot. */
	private async withFabricMessage(event: TaskChangedEvent): Promise<TaskChangedEvent> {
		if (event.fabricMessage || event.status !== 'input_required') return event;
		const row = this.fabricMessageRow('task_id', event.taskId);
		if (!row) return event;
		const task = this.getTask(event.taskId);
		const payload = (task?.payload ?? {}) as Record<string, unknown>;
		return {
			...event,
			fabricMessage: {
				messageId: String(row.message_id),
				from: String(row.from_address),
				text: String(payload.text ?? ''),
				inReplyTo: (payload.in_reply_to as string | null | undefined) ?? null,
				expectsReply: payload.expects_reply === true,
				sentAt: payload.sent_at ? String(payload.sent_at) : undefined,
				replyCapability: String(row.capability),
				capabilityExpiresAt: String(row.expires_at),
				howToReply:
					'Answer with acknowledge_result(task_id, receipt: {reply: "<your answer>", capability: "<replyCapability>"}). ' +
					'To message another Fabric agent, delegate work, or read Fabric, call send, delegate or query with the same capability.',
			},
		};
	}

	/**
	 * A message from Fabric for the Dot (DOTS D4): a `fabric_message` task under
	 * the Dot's subscription, whose `task_changed` event goes to that
	 * subscription alone and is sent before this returns. Idempotent by the
	 * Fabric message id: a message dots-host sends again is the same task and
	 * the same event, and one already delivered is not sent again.
	 */
	async deliverFabricMessage(
		message: FabricMessageIn,
		subscriptionId: string | undefined,
	): Promise<FabricDelivery> {
		if (
			!message ||
			typeof message.message_id !== 'string' ||
			!message.message_id ||
			typeof message.text !== 'string' ||
			typeof message.from !== 'string'
		) {
			return { delivered: false, reason: 'invalid' };
		}
		const sub = subscriptionId ? this.subscriptionById(subscriptionId) : null;
		if (!sub) return { delivered: false, reason: 'no_subscription' };

		let row = this.fabricMessageRow('message_id', message.message_id);
		if (row?.delivered_at) {
			return { delivered: true, taskId: String(row.task_id) };
		}
		let event: TaskChangedEvent;
		if (row) {
			const stored = this.listEvents({ taskId: String(row.task_id) }).find(
				(e) => e.eventId === String(row!.event_id),
			);
			if (!stored) return { delivered: false, reason: 'invalid' };
			event = stored;
		} else {
			const now = new Date();
			const taskId = `task_${randomHex(8)}`;
			const eventId = `evt_${randomHex(8)}`;
			const capability = `cap_${randomHex(16)}`;
			const expiresAt = new Date(now.getTime() + CAPABILITY_TTL_MS).toISOString();
			const correlationId = sub.filter?.correlationId;
			const summary =
				`Fabric message from ${message.from}${message.expects_reply ? ' (expects a reply)' : ''}: ` +
				message.text.slice(0, 500) +
				(message.text.length > 500 ? '…' : '');
			const payload = {
				kind: 'fabric_message',
				message_id: message.message_id,
				from: message.from,
				text: message.text,
				in_reply_to: message.in_reply_to ?? null,
				expects_reply: message.expects_reply === true,
				sent_at: message.sent_at,
				proc: DOT_PROC,
			};
			const at = now.toISOString();
			const task: TaskRecord = {
				id: taskId,
				correlationId,
				type: 'fabric_message',
				status: 'input_required',
				revision: 1,
				summary,
				payload,
				createdAt: at,
				updatedAt: at,
			};
			row = {
				message_id: message.message_id,
				task_id: taskId,
				event_id: eventId,
				subscription_id: sub.id,
				from_address: message.from,
				capability,
				capability_hash: await sha256Hex(capability),
				expires_at: expiresAt,
				delivered_at: null,
				replied_at: null,
				created_at: at,
			};
			if (this.sql) {
				this.sql.exec(
					`INSERT INTO mcp_tasks (id, correlation_id, type, status, revision, summary, payload, created_at, updated_at)
					 VALUES (?, ?, 'fabric_message', 'input_required', 1, ?, ?, ?, ?)`,
					taskId,
					correlationId ?? null,
					summary,
					JSON.stringify(payload),
					at,
					at,
				);
				this.sql.exec(
					`INSERT INTO fabric_messages (message_id, task_id, event_id, subscription_id, from_address, capability, capability_hash, expires_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					row.message_id,
					taskId,
					eventId,
					sub.id,
					message.from,
					capability,
					row.capability_hash,
					expiresAt,
					at,
				);
			} else {
				this.tasks.set(taskId, task);
				this.fabricMessages.set(message.message_id, row);
			}
			event = {
				event: 'task_changed',
				eventId,
				taskId,
				correlationId,
				revision: 1,
				cursor: '1',
				status: 'input_required',
				summary,
				timestamp: at,
			};
			this.recordEvent(event, sub.id, false);
		}
		const sent = await this.deliverEvent(sub, await this.withFabricMessage(event));
		if (!sent.ok) {
			return {
				delivered: false,
				taskId: String(row.task_id),
				statusCode: sent.status,
				reason: sent.status ? 'webhook_refused' : 'webhook_unreachable',
			};
		}
		const deliveredAt = new Date().toISOString();
		if (this.sql) {
			this.sql.exec(
				`UPDATE fabric_messages SET delivered_at = ? WHERE message_id = ?`,
				deliveredAt,
				message.message_id,
			);
		} else {
			row.delivered_at = deliveredAt;
		}
		return { delivered: true, taskId: String(row.task_id), statusCode: sent.status };
	}

	/**
	 * Checks a capability the Dot quoted (DOTS D7): it must name a Fabric
	 * message delivered to the Dot's subscription, be unexpired, and be within
	 * the call budget. Each accepted call is counted.
	 */
	private async admitCapability(capability: unknown, tool: string): Promise<Record<string, unknown>> {
		if (typeof capability !== 'string' || !capability.startsWith('cap_')) {
			throw new FabricRefusal(
				'Fabric tools need the capability from a Fabric message event (fabricMessage.replyCapability).',
			);
		}
		const hash = await sha256Hex(capability);
		const row = this.fabricMessageRow('capability_hash', hash);
		if (!row || !row.delivered_at) throw new FabricRefusal('That capability is not one Fabric gave the Dot.');
		if (Date.parse(String(row.expires_at)) <= Date.now()) {
			throw new FabricRefusal('That capability has expired; use the one from a newer Fabric message.');
		}
		const now = Date.now();
		const hourAgo = new Date(now - 3_600_000).toISOString();
		const dayAgo = new Date(now - 86_400_000).toISOString();
		let perCapability: number;
		let perDay: number;
		if (this.sql) {
			this.sql.exec(`DELETE FROM fabric_calls WHERE at < ?`, new Date(now - 2 * 86_400_000).toISOString());
			perCapability = Number(
				this.sql
					.exec(`SELECT COUNT(*) AS n FROM fabric_calls WHERE capability_hash = ? AND at >= ?`, hash, hourAgo)
					.toArray()[0]?.n ?? 0,
			);
			perDay = Number(
				this.sql.exec(`SELECT COUNT(*) AS n FROM fabric_calls WHERE at >= ?`, dayAgo).toArray()[0]?.n ?? 0,
			);
		} else {
			perCapability = this.fabricCalls.filter((c) => c.capabilityHash === hash && c.at >= now - 3_600_000).length;
			perDay = this.fabricCalls.filter((c) => c.at >= now - 86_400_000).length;
		}
		if (perCapability >= CALLS_PER_CAPABILITY_HOUR || perDay >= CALLS_PER_DAY) {
			throw new FabricRefusal(
				`Fabric call budget spent (${CALLS_PER_CAPABILITY_HOUR} an hour per capability, ${CALLS_PER_DAY} a day); try later.`,
			);
		}
		if (this.sql) {
			this.sql.exec(
				`INSERT INTO fabric_calls (capability_hash, tool, at) VALUES (?, ?, ?)`,
				hash,
				tool,
				new Date(now).toISOString(),
			);
		} else {
			this.fabricCalls.push({ capabilityHash: hash, at: now });
		}
		return row;
	}

	/** One of the Dot's Fabric tools (DOTS D5), behind its capability (D7). */
	async fabricCall(
		tool: 'send' | 'delegate' | 'query',
		args: Record<string, unknown>,
	): Promise<unknown> {
		if (!this.fabric) throw new FabricRefusal('Fabric is not connected to this library.');
		const { capability, ...rest } = args;
		await this.admitCapability(capability, tool);
		this.logAudit('fabric:call', { tool, to: typeof rest.to === 'string' ? rest.to : undefined });
		return this.fabric(tool, rest);
	}

	/**
	 * acknowledge_result on a Fabric message's task: the Dot's answer, sent to
	 * the message's sender in its thread (reply_to the Fabric message), and the
	 * task completed. The receipt must quote that message's capability.
	 */
	async replyFabricMessage(
		taskId: string,
		receipt: unknown,
	): Promise<{ replied: boolean; sent?: unknown } | null> {
		const row = this.fabricMessageRow('task_id', taskId);
		if (!row) return null;
		const r = (receipt ?? {}) as Record<string, unknown>;
		const capability = r.capability;
		if (typeof capability !== 'string' || (await sha256Hex(capability)) !== String(row.capability_hash)) {
			throw new FabricRefusal(
				'This task is a Fabric message: quote its capability (fabricMessage.replyCapability) in receipt.capability.',
			);
		}
		const reply = typeof r.reply === 'string' ? r.reply : typeof r.text === 'string' ? r.text : undefined;
		let sent: unknown;
		if (reply) {
			if (!this.fabric) throw new FabricRefusal('Fabric is not connected to this library.');
			await this.admitCapability(capability, 'send');
			sent = await this.fabric('send', {
				to: String(row.from_address),
				text: reply,
				reply_to: String(row.message_id),
			});
		}
		const task = this.getTask(taskId);
		if (task && task.status === 'input_required') {
			const now = new Date().toISOString();
			const revision = task.revision + 1;
			const summary = reply
				? `Answered Fabric message ${String(row.message_id)} to ${String(row.from_address)}; nothing further is owed.`
				: `Fabric message ${String(row.message_id)} acknowledged; nothing further is owed.`;
			if (this.sql) {
				this.sql.exec(
					`UPDATE mcp_tasks SET status = 'completed', revision = ?, summary = ?, updated_at = ? WHERE id = ?`,
					revision,
					summary,
					now,
					taskId,
				);
				this.sql.exec(
					`UPDATE fabric_messages SET replied_at = ? WHERE task_id = ?`,
					reply ? now : null,
					taskId,
				);
			} else {
				Object.assign(task, { status: 'completed', revision, summary, updatedAt: now });
				this.tasks.set(taskId, task);
				if (reply) row.replied_at = now;
			}
			this.recordEvent(
				{
					event: 'task_changed',
					eventId: `evt_${randomHex(8)}`,
					taskId,
					correlationId: task.correlationId,
					revision,
					status: 'completed',
					summary,
					timestamp: now,
				},
				String(row.subscription_id),
			);
		}
		return { replied: Boolean(reply), sent };
	}

	/** fabricCall, a refusal given back as `{refused}` (it crosses DO RPC). */
	async fabricTool(
		tool: 'send' | 'delegate' | 'query',
		args: Record<string, unknown>,
	): Promise<{ result?: unknown; refused?: string }> {
		try {
			return { result: await this.fabricCall(tool, args) };
		} catch (error) {
			if (error instanceof FabricRefusal) return { refused: error.message };
			throw error;
		}
	}

	/** replyFabricMessage, a refusal given back as `{refused}`; `null` result for a task that is not a Fabric message. */
	async fabricReply(
		taskId: string,
		receipt: unknown,
	): Promise<{ result?: { replied: boolean; sent?: unknown } | null; refused?: string }> {
		try {
			return { result: await this.replyFabricMessage(taskId, receipt) };
		} catch (error) {
			if (error instanceof FabricRefusal) return { refused: error.message };
			throw error;
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
				this.saveNote(path, content);

				for (const concept of story.concepts) {
					const conceptTitle = concept.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
					const slug = slugify(conceptTitle);
					const cPath = `concepts/${slug}.md`;
					const cContent = (await vault.getNote(cPath)) ?? '';
					if (cContent) {
						this.saveNote(cPath, cContent);
					}
				}
				const idxContent = (await vault.getNote('index.md')) ?? '';
				if (idxContent) {
					this.saveNote('index.md', idxContent);
				}

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
					artifacts: [
						path,
						...concepts.map((c) => `concepts/${slugify(c.replace(/[[\]]/g, '').trim())}.md`),
					],
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
				const vaultPaths = await vault.listNotes();
				const storePaths = this.listNotes();
				const allPaths = Array.from(new Set([...vaultPaths, ...storePaths])).sort();
				const matches: Array<{ path: string; excerpt: string }> = [];

				for (const path of allPaths) {
					let text = await vault.getNote(path);
					if (!text) {
						text = this.getNote(path);
					}
					if (query.trim().length > 0 && text && text.toLowerCase().includes(query.toLowerCase())) {
						const lowerText = text.toLowerCase();
						const qLower = query.toLowerCase();
						const matchIdx = lowerText.indexOf(qLower);
						let excerpt = text.slice(0, 200);
						if (matchIdx >= 0) {
							const start = Math.max(0, matchIdx - 40);
							const end = Math.min(text.length, matchIdx + qLower.length + 120);
							excerpt =
								(start > 0 ? '...' : '') +
								text.slice(start, end).trim() +
								(end < text.length ? '...' : '');
						}
						matches.push({ path, excerpt });
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

/**
 * The Dot's way to Fabric (fabric/DOTS.md D5): the service binding
 * FABRIC_DOTS to the Worker fabric-cursor-tools' DotsLibrary entrypoint,
 * whose relay carries the call to dots-host, which makes it as the Dot's proc.
 * FABRIC_DOTS_TOKEN (D6) is what dots-host checks.
 */
export function fabricCaller(env: Record<string, unknown> | undefined): FabricCaller | undefined {
	const binding = env?.FABRIC_DOTS as { fetch(request: Request): Promise<Response> } | undefined;
	const token = env?.FABRIC_DOTS_TOKEN;
	if (!binding || typeof binding.fetch !== 'function' || typeof token !== 'string' || !token) {
		return undefined;
	}
	return async (tool, args) => {
		const response = await binding.fetch(
			new Request('https://fabric-dots/library/call', {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ tool, arguments: args }),
			}),
		);
		const text = await response.text();
		if (!response.ok) throw new FabricRefusal(`Fabric did not answer (${response.status}): ${text.slice(0, 300)}`);
		return JSON.parse(text);
	};
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
				this.mcpTaskStore = new TaskStore(() => getOrCreateVault(env), {
					sql: ctx?.storage?.sql,
					ctx,
					fabric: fabricCaller(env),
				});
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
			subscriptionId?: string;
		}): Promise<{
			subscription: SubscriptionRecord;
			replayedEvents: TaskChangedEvent[];
			cursor: string;
		}> {
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

		async getMcpNote(path: string): Promise<string | null> {
			return this.getMcpStore().getNote(path);
		}

		async listMcpNotes(prefix?: string): Promise<string[]> {
			return this.getMcpStore().listNotes(prefix);
		}

		async logMcpAudit(category: string, details: Record<string, unknown>): Promise<void> {
			this.getMcpStore().logAudit(category, details);
		}

		async deliverFabricMessage(message: FabricMessageIn, subscriptionId: string | undefined) {
			return this.getMcpStore().deliverFabricMessage(message, subscriptionId);
		}

		async fabricMcpTool(tool: 'send' | 'delegate' | 'query', args: Record<string, unknown>) {
			return this.getMcpStore().fabricTool(tool, args);
		}

		async fabricMcpReply(taskId: string, receipt: unknown) {
			return this.getMcpStore().fabricReply(taskId, receipt);
		}

		async listMcpSubscriptions() {
			return this.getMcpStore().listSubscriptions();
		}

		async getMcpAuditLogs(
			limit?: number,
		): Promise<Array<{ id: string; category: string; details: unknown; timestamp: string }>> {
			return this.getMcpStore().getAuditLogs(limit);
		}
	} as unknown as TBase;
}
