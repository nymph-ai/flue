/**
 * Test support for the A2A entity layer: a "world" of entities, each a real
 * `FluePiHost` over `StreamStorage` (node:sqlite file + a shared
 * `DurableStreamLog`) driven by pi-ai's faux provider, with its
 * `EntityRuntime`; plus an Ed25519 webhook signer that produces wakes in the
 * bare Durable Streams and the agents-server formats.
 *
 * Imported only by `*.test.ts`; never part of a build entry.
 */
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
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { encodeBase64 } from '../base64.ts';
import type { FenceReason } from '../pi/commit-outbox.ts';
import { createFluePiHost, type FluePiHost, type WakeReason } from '../pi/host.ts';
import { renderedAgentFrom } from '../pi/registry-bridge.ts';
import { context, tempFile } from '../pi/stream-storage-test-support.ts';
import { StreamStorage } from '../pi/stream-storage.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import { STREAM_START, type StreamOffset } from '../streams/offset.ts';
import type { EntitySubscriptionPort } from './facet.ts';
import { entityKey, wirePath } from './paths.ts';
import { createEntityRuntime, type EntityRuntime } from './runtime.ts';
import type { EntityRef } from './services.ts';
import { handleEntityWake, type EntityWakeRequest, type EntityWakeResult } from './wake-handler.ts';
import type { WebhookJwk } from './webhook.ts';

export { context };

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

/** One addressable entity: survives `close()` (sqlite file + the shared log) like an evicted DO. */
export class TestEntity {
	readonly ref: EntityRef;
	readonly world: TestWorld;
	readonly respond: Responder;
	file: string | undefined;
	storage: StreamStorage | undefined;
	host: FluePiHost | undefined;
	runtime: EntityRuntime | undefined;
	readonly wakes: { atMs: number; reason: WakeReason }[] = [];
	readonly reports: unknown[] = [];
	readonly fences: { epoch: number; reason: FenceReason }[] = [];
	/** Model requests across every incarnation. */
	calls = 0;
	#opening: Promise<EntityRuntime> | undefined;

	constructor(world: TestWorld, ref: EntityRef, respond: Responder) {
		this.world = world;
		this.ref = ref;
		this.respond = respond;
	}

	get isOpen(): boolean {
		return this.runtime !== undefined;
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
		this.file ??= await tempFile(`${this.ref.type}-${this.ref.id.replaceAll('/', '_')}.sqlite`);
		const file = this.file;
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses(
			Array.from({ length: 200 }, () => (request: { messages: Message[] }) => {
				this.calls++;
				return this.respond(request.messages);
			}),
		);
		const armWake = async (atMs: number, reason: WakeReason) => {
			this.wakes.push({ atMs, reason });
		};
		const log = this.world.wrapLog(this, this.world.log);
		const host = createFluePiHost({
			entity: this.ref,
			models,
			storage: async () => {
				this.storage = await StreamStorage.open(
					{
						database: this.world.wrapDatabase(this, await openNodeSqliteDatabase(file)),
						log,
						entity: this.ref,
						now: () => this.world.clock.now,
						onFenced: (epoch, reason) => this.fences.push({ epoch, reason }),
						onReport: (error) => this.reports.push(error),
						armWake: (atMs) => armWake(atMs, { kind: 'outbox' }),
						backoff: { initialMs: 60_000, maxMs: 60_000 },
					},
					context,
				);
				return this.storage;
			},
			now: () => this.world.clock.now,
			onReport: (error) => this.reports.push(error),
			armWake,
		});
		const runtime = await createEntityRuntime({
			host,
			entity: this.ref,
			log,
			cursors: () => {
				if (!this.storage) throw new Error('storage is not open');
				return this.storage.cursors;
			},
			armWake,
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

	/** Evict: dispose everything in memory; the sqlite file and the log stay. */
	async close(): Promise<void> {
		await this.#opening?.catch(() => {});
		const runtime = this.runtime;
		const host = this.host;
		this.runtime = undefined;
		this.host = undefined;
		await runtime?.dispose();
		await host?.close(context);
		this.storage = undefined;
	}

	/**
	 * Crash: forget everything in memory without closing anything, as a killed
	 * isolate does. Whatever the old incarnation still has in flight runs on
	 * against the faults its wrappers inject; the next `open()` is a new one.
	 */
	abandon(): void {
		this.runtime = undefined;
		this.host = undefined;
		this.storage = undefined;
		this.#opening = undefined;
	}

	/** The coordinator's `__flueWake`: open (reconstruct) if asleep, then handle. */
	async wake(request: EntityWakeRequest): Promise<EntityWakeResult> {
		this.world.woken.push({ entity: entityKey(this.ref), request });
		const runtime = await this.open();
		return handleEntityWake(runtime, request, context);
	}

	requireHost(): FluePiHost {
		if (!this.host) throw new Error(`${entityKey(this.ref)} is not open`);
		return this.host;
	}

	requireStorage(): StreamStorage {
		if (!this.storage) throw new Error(`${entityKey(this.ref)} is not open`);
		return this.storage;
	}

	/** Publish the Pi log and post relay rows. */
	async flush(): Promise<void> {
		const storage = this.requireStorage();
		await storage.drain();
		await storage.drainRelay();
	}

	async entries(conversationId: ConversationId = ROOT_CONVERSATION_ID): Promise<EntryRecord[]> {
		const conversation = await this.requireHost().harness.conversation(conversationId, context);
		const page = await conversation?.entries({}, 1000, undefined, context);
		return [...(page?.items ?? [])].reverse();
	}

	lastSeq(): number {
		return (this.requireStorage() as unknown as { lastIndexedSeq(): number }).lastIndexedSeq();
	}
}

export class TestWorld {
	readonly log: DurableStreamLog;
	readonly clock: WorldClock = { now: 1_800_000_000_000 };
	readonly entities = new Map<string, TestEntity>();
	readonly woken: { entity: string; request: EntityWakeRequest }[] = [];
	subscriptions: EntitySubscriptionPort | undefined;
	/** Per-incarnation fault wrappers (crash tests); identity by default. */
	wrapLog: (entity: TestEntity, log: DurableStreamLog) => DurableStreamLog = (_entity, log) => log;
	wrapDatabase: (entity: TestEntity, database: SqliteDatabase) => SqliteDatabase = (
		_entity,
		database,
	) => database;

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

	/** The route's `wake` port: `stub(idFromName(entity)).__flueWake(request)`. */
	readonly wake = (ref: EntityRef, request: EntityWakeRequest): Promise<EntityWakeResult> =>
		this.entity(ref).wake(request);

	async closeAll(): Promise<void> {
		for (const entity of this.entities.values()) await entity.close();
	}
}

/** Every message on a stream, in order (empty when it does not exist). */
export async function readAll(log: DurableStreamLog, path: string): Promise<unknown[]> {
	const messages: unknown[] = [];
	let offset: StreamOffset = STREAM_START;
	while (true) {
		let batch: Awaited<ReturnType<DurableStreamLog['read']>>;
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
