/**
 * Support for the crash/replay/concurrency conformance suite
 * (`conformance.test.ts`, nymph-ai/nymphai #3755): the entity stream
 * backends the suite runs against, wake delivery through the real wake route,
 * and normalizers that make two runs comparable. Crashes are the
 * per-incarnation kill switch of `entity/a2a-test-support.ts`.
 *
 * Imported only by `*.test.ts`; never part of a build entry.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Message } from '@earendil-works/pi-ai';
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
import { createEntityWakeRoute } from '../entity/webhook-route.ts';
import { staticWebhookKeys } from '../entity/webhook.ts';
import { SqliteConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { ElectricDurableStreamLog } from '../streams/electric-log.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import { conversationStreamStoreLog } from '../streams/store-bridge-log.ts';

export { context, readAll };

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

/** The in-memory reference log. */
export function memoryBackend(): Backend {
	const log = new InMemoryDurableStreamLog();
	return { name: 'memory', log: () => log, idPrefix: '' };
}

/**
 * The entity streams of a Node app without Electric: its persistence
 * adapter's SQL conversation stream store behind `conversationStreamStoreLog`
 * — here over node:sqlite shaped like DO SQL.
 */
export function bridgeBackend(): Backend {
	const sql = new FakeDurableObjectSql();
	const store = new SqliteConversationStreamStore(sql.sql as never, (closure) =>
		sql.transactionSync(closure),
	);
	return { name: 'bridge (SQL store)', log: () => conversationStreamStoreLog(store), idPrefix: '' };
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
		{ name: 'bridge (SQL store)', make: bridgeBackend },
		...(url ? [{ name: 'durable-streams server', make: () => electricBackend(url) }] : []),
	];
}

// ─── A world with a wake route ──────────────────────────────────────────────

export interface QualWorld {
	readonly backend: Backend;
	readonly world: TestWorld;
	readonly log: DurableStreamLog;
	readonly signer: WebhookSigner;
	readonly callbacks: { url: string; body: unknown }[];
	/** POST a signed wake body to the Worker's wake route. */
	deliver(body: string): Promise<{ status: number; json: Record<string, unknown> }>;
	ref(type: string, id: string): { type: string; id: string };
}

export async function qualWorld(backend: Backend): Promise<QualWorld> {
	const log = backend.log();
	const world = new TestWorld(log);
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
		signer,
		callbacks,
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
	if (results.length > 0) {
		// Not the tool's text: it carries ids derived from random faux call ids.
		const last = lastMessage(messages);
		return answer(
			`Done after ${results.length} ${last?.role === 'toolResult' ? last.toolName : 'tool'} call(s).`,
		);
	}
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
				// Pi task ids in event ids (`{self}/{taskId}/{callId}`) depend on how many
				// records a run minted, which is not part of the public result.
				const stripped = inner
					.replace(/tool:\d+:[a-z0-9]+/g, 'tool:<call>')
					.replace(/\/\d+\/tool:<call>/g, '/<task>/tool:<call>');
				return prefix ? stripped.replaceAll(prefix, '') : stripped;
			}
			return inner;
		}),
	);
}
