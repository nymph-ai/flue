/**
 * Support for the crash/replay/concurrency conformance suite
 * (`conformance.test.ts`, nymph-ai/nymphai #3755): the log backends the suite
 * runs against, a per-incarnation kill switch that turns an entity's database
 * and log into a dead process at a chosen append, wake delivery through the
 * real wake route, and normalizers that make two runs comparable.
 *
 * Imported only by `*.test.ts`; never part of a build entry.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Message } from '@earendil-works/pi-ai';
import type { SqliteDatabase, SqliteStatement } from '@earendil-works/pi-durable/storage/sqlite';
import {
	answer,
	context,
	lastMessage,
	readAll,
	type TestEntity,
	TestWorld,
	textOf,
	toolCall,
	WebhookSigner,
} from '../entity/a2a-test-support.ts';
import { entityKey } from '../entity/paths.ts';
import { createEntityWakeRoute } from '../entity/webhook-route.ts';
import { staticWebhookKeys } from '../entity/webhook.ts';
import { CrashError, loggedEnvelopes } from '../pi/stream-storage-test-support.ts';
import { SqliteConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { ElectricDurableStreamLog } from '../streams/electric-log.ts';
import type { AppendOutcome, DurableStreamLog, ProducerClaim, ReadBatch } from '../streams/log.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import type { StreamOffset } from '../streams/offset.ts';
import { conversationStreamStoreLog } from '../streams/store-bridge-log.ts';

export { CrashError, context, loggedEnvelopes, readAll };

// ─── Backends ───────────────────────────────────────────────────────────────

export interface Backend {
	readonly name: string;
	/** Every call returns a client of the same backing store. */
	log(): DurableStreamLog;
	/** Prefix for entity ids, so runs sharing a server stay apart. */
	readonly idPrefix: string;
}

type DoValue = ArrayBuffer | string | number | null;

/** node:sqlite shaped like Durable Object SQL (`sql.exec` + `transactionSync`). */
export class FakeDurableObjectSql {
	readonly database = new DatabaseSync(':memory:');
	#depth = 0;

	readonly sql = {
		exec: (query: string, ...bindings: unknown[]) => {
			const values = (bindings as DoValue[]).map((binding) =>
				binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
			) as SQLInputValue[];
			const statement = this.database.prepare(query);
			let rows: Record<string, unknown>[] = [];
			if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
				rows = statement.all(...values) as Record<string, unknown>[];
			} else {
				statement.run(...values);
			}
			return { toArray: () => rows };
		},
	};

	transactionSync<T>(closure: () => T): T {
		const name = `do_tx_${this.#depth++}`;
		this.database.exec(`SAVEPOINT ${name}`);
		try {
			const result = closure();
			this.database.exec(`RELEASE ${name}`);
			return result;
		} catch (error) {
			this.database.exec(`ROLLBACK TO ${name}`);
			this.database.exec(`RELEASE ${name}`);
			throw error;
		} finally {
			this.#depth--;
		}
	}
}

let runCounter = 0;
const runId = () => `${Date.now().toString(36)}${(runCounter++).toString(36)}`;

/** The in-memory reference log: Durable Streams producer and Stream-Seq rules, exactly. */
export function memoryBackend(): Backend {
	const log = new InMemoryDurableStreamLog({ longPollTimeoutMs: 200 });
	return { name: 'memory', log: () => log, idPrefix: '' };
}

/**
 * The bridge log a deployment without Electric uses: the Durable Object's own
 * SQLite conversation stream store (`SqliteConversationStreamStore`) behind
 * `conversationStreamStoreLog` — here over node:sqlite shaped like DO SQL.
 */
export function bridgeBackend(): Backend {
	const sql = new FakeDurableObjectSql();
	const store = new SqliteConversationStreamStore(sql.sql as never, (closure) =>
		sql.transactionSync(closure),
	);
	return { name: 'bridge (DO SQLite)', log: () => conversationStreamStoreLog(store), idPrefix: '' };
}

/** The Durable Streams reference server (`scripts/test-durable-streams-server.sh`), when running. */
export function electricBackend(baseUrl: string): Backend {
	return {
		name: 'durable-streams server',
		log: () => new ElectricDurableStreamLog({ baseUrl }),
		idPrefix: `q${runId()}-`,
	};
}

/** A backend kind; every `make()` is a fresh, empty store (or a fresh id space on a shared server). */
export interface BackendSpec {
	readonly name: string;
	make(): Backend;
}

export function backends(): BackendSpec[] {
	const url = process.env.FLUE_DS_URL;
	return [
		{ name: 'memory', make: memoryBackend },
		{ name: 'bridge (DO SQLite)', make: bridgeBackend },
		...(url ? [{ name: 'durable-streams server', make: () => electricBackend(url) }] : []),
	];
}

// ─── Kill switch ────────────────────────────────────────────────────────────

export type FaultKind = 'crash-before-post' | 'crash-after-post' | 'abort-after-commits';

export interface Fault {
	readonly kind: FaultKind;
	/** Appends to let through first (`abort-after-commits`: acknowledged appends). */
	readonly after: number;
	/** Which of the entity's appends count: its Pi log, or relay posts to inboxes. */
	readonly stream: 'pi' | 'inbox';
}

/** One process lifetime of an entity: once killed, its database and log calls all throw. */
export class Incarnation {
	dead = false;
	readonly appends: {
		path: string;
		producer: ProducerClaim;
		streamSeq?: string;
		outcome: string;
	}[] = [];
	#fault: Fault | undefined;
	#seen = 0;
	#acked = 0;
	fired: Fault | undefined;
	/** Runs the moment the incarnation dies: a dead process stops, it does not spin. */
	onDeath: (() => void) | undefined;

	constructor(fault?: Fault) {
		this.#fault = fault;
	}

	/** Arm a fault on this (live) incarnation; appends count from now. */
	arm(fault: Fault): void {
		this.#fault = fault;
		this.#seen = 0;
		this.#acked = 0;
	}

	/** Calls the dead process still made: a dead incarnation that keeps looping shows up here. */
	deadCalls = 0;

	alive(): void {
		if (!this.dead) return;
		this.deadCalls++;
		if (process.env.QUAL_TRACE && (this.deadCalls === 1000 || this.deadCalls === 100_000)) {
			process.stderr.write(
				`[conformance] a dead incarnation made ${this.deadCalls} calls; one came from:\n${new Error('probe').stack?.split('\n').slice(2, 40).join('\n')}\n`,
			);
		}
		throw new CrashError('the process is dead');
	}

	matches(path: string): boolean {
		const fault = this.#fault;
		if (!fault) return false;
		return fault.stream === 'pi' ? path.endsWith('/pi') : path.endsWith('/inbox');
	}

	/** Run one append under the armed fault. */
	async append(path: string, send: () => Promise<AppendOutcome>): Promise<AppendOutcome> {
		this.alive();
		const fault = this.#fault;
		if (!fault || !this.matches(path)) return send();
		this.#seen++;
		if (fault.kind === 'crash-before-post' && this.#seen > fault.after) {
			this.#die(fault);
			throw new CrashError('crash before the POST');
		}
		const outcome = await send();
		if (fault.kind === 'crash-after-post' && this.#seen > fault.after) {
			this.#die(fault);
			throw new CrashError('crash after the POST, before the ack');
		}
		if (fault.kind === 'abort-after-commits' && outcome.status === 'appended') {
			this.#acked++;
			if (this.#acked >= fault.after) this.#die(fault);
		}
		return outcome;
	}

	#die(fault: Fault): void {
		this.dead = true;
		this.fired = fault;
		this.#fault = undefined;
		this.onDeath?.();
	}
}

class KillableLog implements DurableStreamLog {
	constructor(
		private readonly inner: DurableStreamLog,
		private readonly incarnation: Incarnation,
	) {}

	ensure(path: string, signal?: AbortSignal) {
		this.incarnation.alive();
		return this.inner.ensure(path, signal);
	}

	async append(
		path: string,
		input: {
			readonly messages: readonly unknown[];
			readonly producer: ProducerClaim;
			readonly streamSeq?: string;
		},
		signal?: AbortSignal,
	): Promise<AppendOutcome> {
		let status = 'thrown';
		try {
			const outcome = await this.incarnation.append(path, () =>
				this.inner.append(path, input, signal),
			);
			status = outcome.status;
			return outcome;
		} finally {
			this.incarnation.appends.push({
				path,
				producer: input.producer,
				...(input.streamSeq === undefined ? {} : { streamSeq: input.streamSeq }),
				outcome: status,
			});
		}
	}

	read(
		path: string,
		from: StreamOffset,
		options?: {
			readonly live?: false | 'long-poll' | 'sse';
			readonly cursor?: string;
			readonly signal?: AbortSignal;
		},
	): Promise<ReadBatch> {
		this.incarnation.alive();
		return this.inner.read(path, from, options);
	}

	head(path: string, signal?: AbortSignal) {
		this.incarnation.alive();
		return this.inner.head(path, signal);
	}
}

class KillableDatabase implements SqliteDatabase {
	constructor(
		private readonly inner: SqliteDatabase,
		private readonly incarnation: Incarnation,
	) {}

	exec(sql: string): void {
		this.incarnation.alive();
		this.inner.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		this.incarnation.alive();
		const statement = this.inner.prepare(sql);
		const incarnation = this.incarnation;
		return {
			run: (...params) => {
				incarnation.alive();
				return statement.run(...params);
			},
			get: (...params) => {
				incarnation.alive();
				return statement.get(...params);
			},
			all: (...params) => {
				incarnation.alive();
				return statement.all(...params);
			},
		} as SqliteStatement;
	}

	transaction<T>(callback: () => T): T | Promise<T> {
		this.incarnation.alive();
		return this.inner.transaction(() => {
			this.incarnation.alive();
			return callback();
		});
	}

	close(): void | Promise<void> {
		return this.inner.close();
	}
}

// ─── A world with faults and a wake route ───────────────────────────────────

export interface QualWorld {
	readonly backend: Backend;
	readonly world: TestWorld;
	readonly log: DurableStreamLog;
	/** The current incarnation of each entity (`entityKey`). */
	readonly incarnations: Map<string, Incarnation>;
	readonly signer: WebhookSigner;
	readonly callbacks: { url: string; body: unknown }[];
	/** Arm a fault on the entity's open incarnation, else on its next one. */
	arm(entity: TestEntity, fault: Fault): void;
	incarnation(entity: TestEntity): Incarnation;
	/** POST a signed wake body to the Worker's wake route. */
	deliver(body: string): Promise<{ status: number; json: Record<string, unknown> }>;
	ref(type: string, id: string): { type: string; id: string };
}

export async function qualWorld(backend: Backend): Promise<QualWorld> {
	const log = backend.log();
	const world = new TestWorld(log);
	const incarnations = new Map<string, Incarnation>();
	const armed = new Map<string, Fault>();
	world.wrapLog = (entity, inner) => {
		const key = entityKey(entity.ref);
		const fault = armed.get(key);
		armed.delete(key);
		const incarnation = new Incarnation(fault);
		// Stop the dead incarnation's work right away (its scheduler would
		// otherwise retry against storage that only throws, without yielding).
		incarnation.onDeath = () => entity.abandon();
		incarnations.set(key, incarnation);
		return new KillableLog(inner, incarnation);
	};
	world.wrapDatabase = (entity, database) => {
		const incarnation = incarnations.get(entityKey(entity.ref));
		if (!incarnation) throw new Error('wrapLog runs before wrapDatabase');
		return new KillableDatabase(database, incarnation);
	};
	const signer = await WebhookSigner.create();
	const callbacks: QualWorld['callbacks'] = [];
	const route = createEntityWakeRoute({
		keys: staticWebhookKeys({ keys: [signer.jwk] }),
		wake: world.wake,
		now: () => world.clock.now,
		fetch: async (url, init) => {
			callbacks.push({ url, body: JSON.parse(String(init?.body)) });
			return Response.json({ ok: true, next_wake: false });
		},
	});
	return {
		backend,
		world,
		log,
		incarnations,
		signer,
		callbacks,
		arm(entity, fault) {
			const current = entity.isOpen ? incarnations.get(entityKey(entity.ref)) : undefined;
			if (current) current.arm(fault);
			else armed.set(entityKey(entity.ref), fault);
		},
		incarnation(entity) {
			const incarnation = incarnations.get(entityKey(entity.ref));
			if (!incarnation) throw new Error(`${entityKey(entity.ref)} never opened`);
			return incarnation;
		},
		async deliver(body) {
			const response = await route.fetch(
				await signer.request('https://flue.test/__flue/streams/wake', body, world.clock.now),
			);
			return { status: response.status, json: (await response.json()) as Record<string, unknown> };
		},
		ref: (type, id) => ({ type, id: `${backend.idPrefix}${id}` }),
	};
}

// ─── Scripts ────────────────────────────────────────────────────────────────

/**
 * The society's script, in miniature: `chain N` publishes N events in N tool
 * rounds; `send <type>/<id> <text>` messages another entity; "ping" from an
 * entity is answered with "pong"; anything else is acknowledged.
 */
export function societyResponder(messages: readonly Message[]) {
	const userIndex = messages.findLastIndex((message) => message.role === 'user');
	const results = messages.slice(userIndex + 1).filter((message) => message.role === 'toolResult');
	const text = textOf(messages[userIndex]);
	const signal =
		/<signal [^>]*from_type="([^"]*)" from_id="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/signal>/.exec(text);
	const body = (signal ? (signal[3] as string) : text).trim();
	const chain = /^chain (\d+)/.exec(body);
	if (chain) {
		const rounds = Number(chain[1]);
		return results.length < rounds
			? // No event_id: the default derives from the tool call, so only a
				// rerun of the same call deduplicates — a second generation would not.
				toolCall('publish_event', { event: { round: results.length + 1, of: rounds } })
			: answer(`Chain of ${rounds} published.`);
	}
	if (results.length > 0) return answer(`Done: ${textOf(lastMessage(messages)).slice(0, 60)}`);
	const send = /^send ([^/\s]+)\/(\S+) (.*)$/.exec(body);
	if (send) {
		return toolCall('send_message', {
			target: { type: send[1], id: send[2] },
			text: send[3],
		});
	}
	if (signal && /^ping/.test(body)) {
		return toolCall('send_message', {
			target: { type: signal[1], id: signal[2] },
			text: body.replace(/^ping/, 'pong'),
		});
	}
	return answer(`ack: ${body.slice(0, 40)}`);
}

// ─── Comparable results ─────────────────────────────────────────────────────

/** An entity's history as a reader sees it: entry kinds, texts and data, without ids or times. */
export async function transcript(entity: TestEntity) {
	return (await entity.entries()).map((entry) => ({
		kind: entry.kind,
		text: textOf(entry.model?.[0]),
		data: normalizeIds(entry.data ?? null),
	}));
}

/** Strip what legitimately differs between runs: ids derived from tasks/calls and the id prefix. */
export function normalizeIds(value: unknown, prefix = ''): unknown {
	return JSON.parse(
		JSON.stringify(value ?? null, (key, inner) => {
			if (['messageId', 'submissionId', 'eventId', 'requestId', 'at', 'acceptedAt'].includes(key)) {
				return typeof inner === 'string' || typeof inner === 'number' ? '<id>' : inner;
			}
			if (typeof inner === 'string') {
				// Faux tool call ids are random (pi-ai's `fauxToolCall`), and so are
				// the message/event ids derived from them.
				const stripped = inner.replace(/tool:\d+:[a-z0-9]+/g, 'tool:<call>');
				return prefix ? stripped.replaceAll(prefix, '') : stripped;
			}
			return inner;
		}),
	);
}

export function seqsOf(envelopes: readonly { seq: number }[]): number[] {
	return envelopes.map((envelope) => envelope.seq);
}

export function contiguous(seqs: readonly number[]): boolean {
	return seqs.every((seq, index) => seq === index + 1);
}
