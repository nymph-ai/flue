/**
 * Test support for the A2A entity layer: a "world" of entities, each a real
 * `FluePiHost` over Pi's own `SqliteStorage` (a node:sqlite file per entity,
 * through Flue's row-counting facade) driven by pi-ai's faux provider, with
 * its `EntityRuntime`, its wake book and an alarm — what one Durable Object
 * holds; plus an Ed25519 webhook signer that produces wakes in the bare
 * Durable Streams and the agents-server formats.
 *
 * Every open of an entity is one **incarnation**. `kill()` makes the open
 * incarnation a dead process: every later database or stream call it makes
 * throws `CrashError("the process is dead")`, so nothing it still has in
 * flight reaches storage, and the next `open()` is a new incarnation over the
 * same file — what an eviction or an isolate crash leaves behind. A
 * {@link Fault} kills an incarnation at a chosen point on its own.
 *
 * Imported only by `*.test.ts`; never part of a build entry.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	type AssistantMessage,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
} from '@earendil-works/pi-ai';
import {
	type ConversationId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable';
import {
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteValue,
	SqliteStorage,
} from '@earendil-works/pi-durable/storage/sqlite';
import type {
	CountingSqliteDatabase,
	SqliteStatement,
} from '../cloudflare/do-sqlite-database.ts';
import { encodeBase64 } from '../base64.ts';
import { openNodeSqliteDatabase } from '../node/node-sqlite-database.ts';
import { createFluePiHost, type FluePiHost, type WakeReason } from '../pi/host.ts';
import { renderedAgentFrom } from '../pi/registry-bridge.ts';
import type { DurableStreamLog, ReadBatch } from '../streams/log.ts';
import { STREAM_START, type StreamOffset } from '../streams/offset.ts';
import type { EntitySubscriptionPort } from './facet.ts';
import { entityKey, wirePath } from './paths.ts';
import { type PumpLimits, type PumpResult, pumpEntity } from './pump.ts';
import { createEntityRuntime, type EntityRuntime } from './runtime.ts';
import type { EntityRef } from './services.ts';
import { EntityWakeBook } from './wake-book.ts';
import type { EntityDoorbell } from './webhook-route.ts';
import type { WebhookJwk } from './webhook.ts';
import { FlueReactor } from '../reactor/reactor.ts';
import { FlueReactorStore } from '../reactor/reactor-store.ts';

export const context: Context = BACKGROUND_CONTEXT;

const directories = new Set<string>();

export async function tempFile(name = 'pi.sqlite'): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'flue-entity-'));
	directories.add(directory);
	return join(directory, name);
}

export async function removeTempFiles(): Promise<void> {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
}

/** What a dead incarnation's calls throw (`vitest.config.ts` ignores its stray rejections). */
export class CrashError extends Error {
	constructor(message = 'the process is dead') {
		super(message);
		this.name = 'CrashError';
	}
}

export type Responder = (messages: readonly Message[]) => AssistantMessage;

export function textOf(message: Message | undefined): string {
	if (!message || message.role === 'system') return '';
	const content = message.content;
	if (typeof content === 'string') return content;
	return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** The last non-system message of a request. */
export function lastMessage(messages: readonly Message[]): Message | undefined {
	return messages.findLast((message) => message.role !== 'system');
}

export const toolCall = (
	name: string,
	args: Record<string, unknown>,
	id?: string,
): AssistantMessage =>
	fauxAssistantMessage([fauxToolCall(name, args as never, id === undefined ? undefined : { id })], {
		stopReason: 'toolUse',
	});

export const answer = (text: string): AssistantMessage => fauxAssistantMessage(text);

export interface WorldClock {
	now: number;
}

// ─── Faults ─────────────────────────────────────────────────────────────────

/**
 * Where an incarnation dies: before or after its `after+1`-th append to an
 * entity inbox (a send), or once it has committed `after` Pi transactions.
 */
export type Fault =
	| { readonly kind: 'crash-before-send' | 'crash-after-send'; readonly after: number }
	| { readonly kind: 'abort-after-commits'; readonly after: number };

/** One process lifetime of an entity. */
export class Incarnation {
	dead = false;
	fired: Fault | undefined;
	/** Every append this incarnation made: path and outcome. */
	readonly appends: { path: string; outcome: 'appended' | 'thrown' }[] = [];
	#fault: Fault | undefined;
	#sends = 0;
	#commits = 0;
	onDeath: (() => void) | undefined;

	arm(fault: Fault): void {
		this.#fault = fault;
		this.#sends = 0;
		this.#commits = 0;
	}

	alive(): void {
		if (this.dead) throw new CrashError();
	}

	kill(fault?: Fault): void {
		if (this.dead) return;
		this.dead = true;
		this.fired = fault;
		this.#fault = undefined;
		this.onDeath?.();
	}

	async append<T>(path: string, send: () => Promise<T>): Promise<T> {
		this.alive();
		const fault = this.#fault;
		const counted = fault && fault.kind !== 'abort-after-commits' && path.endsWith('/inbox');
		if (counted) this.#sends++;
		if (counted && fault.kind === 'crash-before-send' && this.#sends > fault.after) {
			this.appends.push({ path, outcome: 'thrown' });
			this.kill(fault);
			throw new CrashError('crash before the POST');
		}
		const result = await send();
		this.appends.push({ path, outcome: 'appended' });
		if (counted && fault.kind === 'crash-after-send' && this.#sends > fault.after) {
			this.kill(fault);
			throw new CrashError('crash after the POST, before its result');
		}
		return result;
	}

	committed(): void {
		const fault = this.#fault;
		if (fault?.kind !== 'abort-after-commits') return;
		this.#commits++;
		if (this.#commits >= fault.after) this.kill(fault);
	}
}

class KillableLog implements DurableStreamLog {
	constructor(
		private readonly inner: DurableStreamLog,
		private readonly incarnation: () => Incarnation | undefined,
	) {}

	#alive(): Incarnation | undefined {
		const incarnation = this.incarnation();
		incarnation?.alive();
		return incarnation;
	}

	ensure(path: string, signal?: AbortSignal) {
		this.#alive();
		return this.inner.ensure(path, signal);
	}

	append(path: string, messages: readonly unknown[], signal?: AbortSignal) {
		const incarnation = this.#alive();
		const send = () => this.inner.append(path, messages, signal);
		return incarnation ? incarnation.append(path, send) : send();
	}

	read(
		path: string,
		from: StreamOffset,
		options?: { readonly signal?: AbortSignal },
	): Promise<ReadBatch> {
		this.#alive();
		return this.inner.read(path, from, options);
	}

	head(path: string, signal?: AbortSignal) {
		this.#alive();
		return this.inner.head(path, signal);
	}
}

class KillableDatabase implements CountingSqliteDatabase {
	constructor(
		readonly inner: CountingSqliteDatabase,
		private readonly incarnation: Incarnation,
	) {}

	get rows() {
		return this.inner.rows;
	}

	async exec(sql: string): Promise<void> {
		this.incarnation.alive();
		await this.inner.exec(sql);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.incarnation.alive();
		await this.inner.run(sql, ...params);
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		this.incarnation.alive();
		return await this.inner.get<T>(sql, ...params);
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.incarnation.alive();
		return await this.inner.all<T>(sql, ...params);
	}

	prepare(sql: string): SqliteStatement {
		this.incarnation.alive();
		const statement = this.inner.prepare(sql);
		const incarnation = this.incarnation;
		return {
			run: (...params) => {
				incarnation.alive();
				statement.run(...params);
			},
			get: (...params) => {
				incarnation.alive();
				return statement.get(...params);
			},
			all: (...params) => {
				incarnation.alive();
				return statement.all(...params);
			},
		};
	}

	async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		this.incarnation.alive();
		const result = await this.inner.transaction(async (tx) => {
			this.incarnation.alive();
			return await callback(tx);
		});
		this.incarnation.committed();
		return result;
	}

	transactionSync<T>(callback: () => T): T {
		this.incarnation.alive();
		const result = this.inner.transactionSync(() => {
			this.incarnation.alive();
			return callback();
		});
		this.incarnation.committed();
		return result;
	}

	async close(): Promise<void> {
		await this.inner.close();
	}
}

// ─── Entities ───────────────────────────────────────────────────────────────

/** One addressable entity: survives `close()` and `kill()` (its SQLite file) like a Durable Object. */
export class TestEntity {
	readonly ref: EntityRef;
	readonly world: TestWorld;
	readonly respond: Responder;
	file: string | undefined;
	host: FluePiHost | undefined;
	runtime: EntityRuntime | undefined;
	reactor: FlueReactor | undefined;
	storage: SqliteStorage | undefined;
	database: KillableDatabase | undefined;
	incarnation: Incarnation | undefined;
	readonly incarnations: Incarnation[] = [];
	/** Pi's own wakes (the live-task backstop, schedules, deadlines): recorded, never auto-run. */
	readonly wakes: { atMs: number; reason: WakeReason }[] = [];
	readonly reports: unknown[] = [];
	/** The Durable Object alarm: armed by a doorbell or a pump that left work behind. */
	alarmArmed = false;
	/** Pumps run, with what each did. */
	readonly pumps: PumpResult[] = [];
	/** Model requests across every incarnation. */
	calls = 0;
	#pendingFault: Fault | undefined;
	#opening: Promise<EntityRuntime> | undefined;
	#book: { book: EntityWakeBook; close(): Promise<void> } | undefined;

	constructor(world: TestWorld, ref: EntityRef, respond: Responder) {
		this.world = world;
		this.ref = ref;
		this.respond = respond;
	}

	get isOpen(): boolean {
		return this.runtime !== undefined;
	}

	async #file(): Promise<string> {
		this.file ??= await tempFile(`${this.ref.type}-${this.ref.id.replaceAll('/', '_')}.sqlite`);
		return this.file;
	}

	/** Arm a fault on the open incarnation, else on the next one. */
	arm(fault: Fault): void {
		if (this.incarnation && !this.incarnation.dead) this.incarnation.arm(fault);
		else this.#pendingFault = fault;
	}

	/** Open (reconstruct) the entity; concurrent callers share one open. */
	open(): Promise<EntityRuntime> {
		if (this.runtime) return Promise.resolve(this.runtime);
		this.#opening ??= this.#open().finally(() => {
			this.#opening = undefined;
		});
		return this.#opening;
	}

	async #open(): Promise<EntityRuntime> {
		const incarnation = new Incarnation();
		if (this.#pendingFault) incarnation.arm(this.#pendingFault);
		this.#pendingFault = undefined;
		incarnation.onDeath = () => this.#abandon();
		this.incarnation = incarnation;
		this.incarnations.push(incarnation);
		const database = new KillableDatabase(
			await openNodeSqliteDatabase(await this.#file()),
			incarnation,
		);
		this.database = database;
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from({ length: 200 }, () => (request: { messages: Message[] }) => {
				this.calls++;
				return this.respond(request.messages);
			}),
		);
		const armWake = async (atMs: number) => {
			this.wakes.push({ atMs, reason: { kind: 'live-tasks' } });
		};
		const log = new KillableLog(this.world.log, () => incarnation);
		const host = createFluePiHost({
			entity: this.ref,
			models,
			storage: async () => {
				this.storage = await SqliteStorage.open(database);
				return this.storage;
			},
			now: () => this.world.clock.now,
			onReport: (error) => this.reports.push(error),
		});
		const store = new FlueReactorStore(database);
		const reactor = new FlueReactor({
			entityRef: this.ref,
			store,
			host,
			entity: () => this.runtime,
			log,
			armWake: (atMs) => {
				this.wakes.push({ atMs, reason: { kind: 'live-tasks' } });
			},
			now: () => this.world.clock.now,
			onReport: (error) => this.reports.push(error),
		});
		this.reactor = reactor;
		const runtime = await createEntityRuntime({
			host,
			entity: this.ref,
			log,
			emitter: reactor,
			now: () => this.world.clock.now,
			onReport: (error) => this.reports.push(error),
			...(this.world.subscriptions ? { subscriptions: this.world.subscriptions } : {}),
		});
		await host.open(context);
		await host.applyRender(renderedAgentFrom({ model: 'faux/faux-1' }), context);
		await runtime.refreshCursors(context);
		this.host = host;
		this.runtime = runtime;
		return runtime;
	}

	/** Evict: dispose everything in memory; the SQLite file stays. */
	async close(): Promise<void> {
		await this.#opening?.catch(() => {});
		const runtime = this.runtime;
		const host = this.host;
		this.runtime = undefined;
		this.host = undefined;
		this.reactor = undefined;
		this.storage = undefined;
		this.database = undefined;
		await runtime?.dispose();
		await host?.close(context);
		await this.#book?.close();
		this.#book = undefined;
	}

	/** Crash: the open incarnation dies where it stands; the next `open()` is a new one. */
	kill(): void {
		this.incarnation?.kill();
	}

	#abandon(): void {
		const runtime = this.runtime;
		const host = this.host;
		this.runtime = undefined;
		this.host = undefined;
		this.reactor = undefined;
		this.storage = undefined;
		this.database = undefined;
		this.#opening = undefined;
		void runtime?.dispose().catch(() => {});
		void host?.close(context).catch(() => {});
	}

	/** The wake book: the open incarnation's database, else its own connection to the file. */
	async book(): Promise<EntityWakeBook> {
		if (this.database && this.incarnation && !this.incarnation.dead)
			return new EntityWakeBook(this.database);
		if (!this.#book) {
			const database = await openNodeSqliteDatabase(await this.#file());
			this.#book = { book: new EntityWakeBook(database), close: async () => database.close() };
		}
		return this.#book.book;
	}

	/**
	 * The `__flueWake({ stream, head })` RPC: record the high-water mark and
	 * arm the alarm. Opens nothing.
	 */
	async doorbell(doorbell: EntityDoorbell): Promise<{ recorded: true }> {
		this.world.woken.push({ entity: entityKey(this.ref), doorbell });
		(await this.book()).ring(doorbell.stream, doorbell.head);
		this.alarmArmed = true;
		if (this.world.autoAlarms) this.world.scheduleAlarm(this);
		return { recorded: true };
	}

	/**
	 * The alarm: open if asleep, tick reactor, and re-arm
	 * while the pump left events behind. Returns the pump's result.
	 */
	async alarm(): Promise<PumpResult> {
		this.alarmArmed = false;
		await this.open();
		const result = await this.reactor!.tick({ reason: { kind: 'pump' }, context });
		const pump = result.pump ?? { behind: false, answered: [], messages: 0 };
		this.pumps.push(pump);
		if (result.behind) {
			this.alarmArmed = true;
			if (this.world.autoAlarms) this.world.scheduleAlarm(this);
		}
		return pump;
	}

	async wake(reason: WakeReason = { kind: 'live-tasks' }, ctx: Context = context): Promise<void> {
		await this.open();
		await this.reactor!.tick({ reason, context: ctx });
	}

	requireHost(): FluePiHost {
		if (!this.host) throw new Error(`${entityKey(this.ref)} is not open`);
		return this.host;
	}

	requireStorage(): SqliteStorage {
		if (!this.storage) throw new Error(`${entityKey(this.ref)} is not open`);
		return this.storage;
	}

	async entries(conversationId: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> {
		const conversation = await this.requireHost().harness.conversation(conversationId, context);
		const page = await conversation?.entries({}, 1000, undefined, context);
		return [...(page?.items ?? [])].reverse();
	}

	/** Rows the open incarnation's database read and wrote. */
	rows(): { rowsRead: number; rowsWritten: number } {
		const rows = this.database?.rows;
		if (!rows) throw new Error(`${entityKey(this.ref)} is not open`);
		return { ...rows };
	}
}

export class TestWorld {
	readonly log: DurableStreamLog;
	readonly clock: WorldClock = { now: 1_800_000_000_000 };
	readonly entities = new Map<string, TestEntity>();
	readonly woken: { entity: string; doorbell: EntityDoorbell }[] = [];
	subscriptions: EntitySubscriptionPort | undefined;
	/** Fire armed alarms by themselves (real-server tests); otherwise `runAlarms()` fires them. */
	autoAlarms = false;
	pumpLimits: PumpLimits | undefined;
	readonly #timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(log: DurableStreamLog) {
		this.log = log;
	}

	entity(ref: EntityRef, respond: Responder = () => answer('ok')): TestEntity {
		const key = entityKey(ref);
		let found = this.entities.get(key);
		if (!found) {
			found = new TestEntity(this, ref, respond);
			this.entities.set(key, found);
		}
		return found;
	}

	/** The route's `wake` port: `stub(idFromName(entity)).__flueWake({ stream, head })`. */
	readonly wake = (ref: EntityRef, doorbell: EntityDoorbell): Promise<{ recorded: true }> =>
		this.entity(ref).doorbell(doorbell);

	scheduleAlarm(entity: TestEntity): void {
		const timer = setTimeout(() => {
			this.#timers.delete(timer);
			if (!entity.alarmArmed) return;
			void entity.alarm().catch((error) => entity.reports.push(error));
		}, 0);
		this.#timers.add(timer);
	}

	/** Fire every armed alarm until none is armed; returns how many fired. */
	async runAlarms(limit = 100): Promise<number> {
		let fired = 0;
		for (let round = 0; round < limit; round++) {
			const armed = [...this.entities.values()].filter((entity) => entity.alarmArmed);
			if (armed.length === 0) return fired;
			for (const entity of armed) {
				await entity.alarm();
				fired++;
			}
		}
		throw new Error(`alarms still armed after ${limit} rounds`);
	}

	async closeAll(): Promise<void> {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		for (const entity of this.entities.values()) await entity.close();
	}
}

/** Every message on a stream, in order (empty when it does not exist). */
export async function readAll(log: DurableStreamLog, path: string): Promise<unknown[]> {
	const messages: unknown[] = [];
	let offset: StreamOffset = STREAM_START;
	while (true) {
		let batch: ReadBatch;
		try {
			batch = await log.read(path, offset);
		} catch {
			return messages;
		}
		messages.push(...batch.messages);
		offset = batch.nextOffset;
		if (batch.upToDate || batch.messages.length === 0) return messages;
	}
}

// ─── Webhook signing ────────────────────────────────────────────────────────

function base64Url(bytes: Uint8Array): string {
	return encodeBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** An Ed25519 signer in the reference servers' format. */
export class WebhookSigner {
	readonly jwk: WebhookJwk;
	readonly #privateKey: CryptoKey;

	private constructor(jwk: WebhookJwk, privateKey: CryptoKey) {
		this.jwk = jwk;
		this.#privateKey = privateKey;
	}

	static async create(): Promise<WebhookSigner> {
		const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
			'sign',
			'verify',
		])) as CryptoKeyPair;
		const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
		const x = exported.x as string;
		const thumbprint = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })),
		);
		return new WebhookSigner(
			{
				kty: 'OKP',
				crv: 'Ed25519',
				x,
				kid: `ds_${base64Url(new Uint8Array(thumbprint))}`,
				use: 'sig',
				alg: 'EdDSA',
			},
			pair.privateKey,
		);
	}

	async sign(body: string, nowMs: number): Promise<string> {
		const t = Math.floor(nowMs / 1000);
		const signature = await crypto.subtle.sign(
			'Ed25519',
			this.#privateKey,
			new TextEncoder().encode(`${t}.${body}`),
		);
		return `t=${t},kid=${this.jwk.kid},ed25519=${base64Url(new Uint8Array(signature))}`;
	}

	async request(url: string, body: string, nowMs: number): Promise<Request> {
		return new Request(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'webhook-signature': await this.sign(body, nowMs),
			},
			body,
		});
	}
}

export interface WakeStreamSpec {
	/** Log path. */
	readonly path: string;
	readonly tailOffset: string;
	readonly ackedOffset?: string;
	readonly pending?: boolean;
}

/** A bare Durable Streams wake body (`subscription-manager.ts` `deliverWebhook`). */
export function durableStreamsWakeBody(input: {
	readonly subscriptionId: string;
	readonly generation: number;
	readonly streams: readonly WakeStreamSpec[];
	readonly wakeId?: string;
}): string {
	return JSON.stringify({
		subscription_id: input.subscriptionId,
		wake_id: input.wakeId ?? `w_${input.generation}`,
		generation: input.generation,
		streams: input.streams.map((stream) => ({
			path: wirePath(stream.path),
			link_type: 'glob',
			acked_offset: stream.ackedOffset ?? '-1',
			tail_offset: stream.tailOffset,
			has_pending: stream.pending ?? true,
		})),
		callback_url: `https://ds.test/v1/stream/__ds/subscriptions/${input.subscriptionId}/callback`,
		callback_token: 'token-123',
	});
}

/**
 * The same wake as the agents-server forwards it (`internal-router.ts`
 * `subscriptionWebhook`): backend fields kept, `streams` cut to the first
 * pending one as `{ path: "/…", offset }`, plus `wakeId`/`consumerId`/
 * `epoch`/`streamPath`/`claimToken`/`callback`.
 */
export function agentsServerWakeBody(input: {
	readonly subscriptionId: string;
	readonly generation: number;
	readonly streams: readonly WakeStreamSpec[];
	readonly publicUrl?: string;
	readonly wakeId?: string;
}): string {
	const backend = JSON.parse(durableStreamsWakeBody(input)) as Record<string, unknown> & {
		streams: { path: string; tail_offset: string; has_pending: boolean }[];
	};
	const primary = backend.streams.find((stream) => stream.has_pending) ?? backend.streams[0];
	if (!primary) throw new Error('no stream');
	const wakeId = backend.wake_id as string;
	const publicUrl = input.publicUrl ?? 'https://agents.test';
	return JSON.stringify({
		...backend,
		callback: `${publicUrl}/_electric/wake-callbacks/${encodeURIComponent(wakeId)}`,
		consumerId: wakeId,
		epoch: input.generation,
		wakeId,
		streamPath: `/${primary.path}`,
		streams: [{ path: `/${primary.path}`, offset: primary.tail_offset }],
		claimToken: backend.callback_token,
	});
}

/** Wait until `predicate` holds, polling (real-server tests). */
export async function eventually<T>(
	probe: () => Promise<T | undefined> | T | undefined,
	options: {
		readonly timeoutMs?: number;
		readonly intervalMs?: number;
		readonly what?: string;
	} = {},
): Promise<T> {
	const deadline = Date.now() + (options.timeoutMs ?? 20_000);
	while (true) {
		const value = await probe();
		if (value !== undefined && (value as unknown) !== false) return value;
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${options.what ?? 'a condition'}`);
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25));
	}
}
