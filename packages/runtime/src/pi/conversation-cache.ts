/**
 * The public conversation wire, cached in the instance's own SQLite
 * (docs/cloudflare-native.md rule 2): Pi's commits never leave the Durable
 * Object, and `@flue/sdk` reads the same `ConversationStreamChunk`s it always
 * did.
 *
 * - **Live.** `attach(harness)` subscribes to `Session.subscribeCommits`.
 *   Each publication is reduced to what the projection reads
 *   (`projectionCommitOf`); a commit that touches none of it costs nothing.
 *   One that does is folded in memory (`projectPiCommitInPlace`) and gets the
 *   next **row** number: its chunks (what readers get) and the reduced commit
 *   (what a cold start refolds).
 * - **Pages.** Rows are stored in pages, one SQLite row each, in
 *   `flue_conversation_log`. Pi commits a streaming partial every 100 ms; a
 *   partial (a commit that only moves `pi.live`) is buffered in memory in the
 *   open page, and the page is written when the next other commit arrives or
 *   after {@link PAGE_ROWS} rows. So a streamed answer costs two rows written
 *   (the page opened, then closed) and every other commit one, and nothing is
 *   read, however long the conversation is. Every
 *   {@link CHECKPOINT_EVERY}th page also rewrites the one-row checkpoint of
 *   the fold state, so a cold start reads the checkpoint plus at most
 *   {@link CHECKPOINT_EVERY} pages.
 *
 *   The listener runs synchronously after Pi adopts the commit and writes
 *   with synchronous SQL. On a Durable Object that is the same turn as Pi's
 *   own write, with no I/O between them, so both land in one coalesced,
 *   atomic storage write ("Rules of Durable Objects": writes without an
 *   intervening await are committed together).
 * - **Offsets** are `{identity}-{row}`: the cache's identity, minted when the
 *   cache is created, and a row number. Reading from `-1` replays every row;
 *   reading from an offset of another identity (a rebuilt cache), or past the
 *   head, answers one `conversation-reset` carrying the head snapshot — the
 *   re-hydration the SDK already performs.
 * - **Rebuild.** An instance with Pi state and no cache (one written before
 *   this cache existed, a cache that failed to write) or a page left open (the
 *   object died mid-stream, so buffered partials were lost) is rebuilt from
 *   Pi reads — the root conversation's entries, its submissions, the receipts
 *   and `pi.live` — under a new identity, so every client re-hydrates once.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	type CommitPublication,
	type ConversationId,
	type Cursor,
	type EntryRecord,
	type Harness,
	LiveDoc,
	ROOT_CONVERSATION_ID,
	type Storage,
	type SubmissionRecord,
} from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { ulid } from 'ulidx';
import type { ConversationStreamChunk } from '../conversation-public.ts';
import type {
	ConversationHead,
	ConversationProjectionSource,
	ConversationRead,
	ConversationSourceMeta,
	ResetWindowProjector,
} from '../runtime/conversation-source.ts';
import { STREAM_START } from '../streams/offset.ts';
import { FlueReceipts, FlueRuns } from './docs.ts';
import {
	initialProjectionState,
	type PiProjectionState,
	type ProjectionChange,
	type ProjectionCommit,
	projectionCommitOf,
	projectPiCommitInPlace,
	projectPiLiveTargets,
	projectPiSnapshot,
	projectPiStreaming,
} from './projection.ts';

/** Rows one page holds at most: what a crash mid-stream can lose (and then rebuilds). */
export const PAGE_ROWS = 64;
/** Pages between checkpoints of the fold state: what a cold start refolds at most. */
export const CHECKPOINT_EVERY = 16;
/** Pages one read returns at most. */
const READ_PAGES = 64;
/** How long a `long-poll` read waits for the next commit before answering up to date. */
export const LONG_POLL_MS = 20_000;

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS flue_conversation_state (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		identity TEXT NOT NULL,
		row INTEGER NOT NULL,
		state TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS flue_conversation_log (
		first_row INTEGER PRIMARY KEY,
		last_row INTEGER NOT NULL,
		closed INTEGER NOT NULL,
		page TEXT NOT NULL,
		folded TEXT NOT NULL
	)`,
];

/** Whether a database holds Pi state (Pi's own metadata table exists). */
export function hasPiState(database: SqliteDatabase): boolean {
	try {
		return (
			database
				.prepare(
					"SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'durable_metadata'",
				)
				.get<{ found: number }>() !== undefined
		);
	} catch {
		return false;
	}
}

function pad(row: number): string {
	return String(row).padStart(12, '0');
}

/** One row: its number and its chunks. */
type Row = [number, ConversationStreamChunk[]];

interface OpenPage {
	readonly first: number;
	readonly rows: Row[];
	readonly folded: ProjectionCommit[];
}

interface Loaded {
	identity: string;
	/** The last row handed out. */
	row: number;
	state: PiProjectionState;
	/** Pages closed since the checkpoint. */
	pages: number;
	/** Partials buffered in memory; its SQLite row marks the page open. */
	open: OpenPage | undefined;
}

/**
 * A streaming partial: a commit that only moves `pi.live` while a generation
 * streams, and only streams chunks. Buffered rather than written; anything
 * else (including the commit that ends the stream) writes the page, so no
 * page stays open once a turn is done.
 */
function isPartial(
	state: PiProjectionState,
	commit: ProjectionCommit,
	chunks: readonly ConversationStreamChunk[],
): boolean {
	return (
		projectPiStreaming(state) &&
		commit.changes.every((change) => change.type === 'doc' && change.kind === 'pi.live') &&
		chunks.every((chunk) => chunk.type === 'message-delta' || chunk.type === 'message-started')
	);
}

export interface PiConversationCacheOptions {
	readonly database: SqliteDatabase;
	/** Open the instance (attaching this cache) when a read finds Pi state but no cache. */
	readonly open?: () => Promise<void>;
	readonly now?: () => number;
	readonly onReport?: (error: unknown) => void;
}

export class PiConversationCache implements ConversationProjectionSource {
	readonly #db: SqliteDatabase;
	readonly #options: PiConversationCacheOptions;
	readonly #now: () => number;
	#schema = false;
	#loaded: Loaded | undefined;
	#waiters = new Set<() => void>();
	#detach: (() => void) | undefined;
	#attached: { readonly harness: Harness; readonly storage: Storage } | undefined;
	#rebuilding: Promise<Loaded | undefined> | undefined;

	constructor(options: PiConversationCacheOptions) {
		this.#db = options.database;
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	#ensureSchema(): void {
		if (this.#schema) return;
		for (const statement of SCHEMA) this.#db.exec(statement);
		this.#schema = true;
	}

	/**
	 * The cache as stored: the checkpoint plus the pages after it, refolded.
	 * `undefined` when absent, or when a page was left open (lost partials).
	 */
	#load(): Loaded | undefined {
		if (this.#loaded) return this.#loaded;
		this.#ensureSchema();
		const checkpoint = this.#db
			.prepare('SELECT identity, row, state FROM flue_conversation_state WHERE singleton = 1')
			.get<{ identity: string; row: number; state: string }>();
		if (!checkpoint) return undefined;
		const state = JSON.parse(checkpoint.state) as PiProjectionState;
		let row = Number(checkpoint.row);
		const pages = this.#db
			.prepare(
				'SELECT last_row, closed, folded FROM flue_conversation_log WHERE first_row > ? ORDER BY first_row',
			)
			.all<{ last_row: number; closed: number; folded: string }>(row);
		for (const page of pages) {
			if (Number(page.closed) !== 1) return undefined;
			for (const commit of JSON.parse(page.folded) as ProjectionCommit[])
				projectPiCommitInPlace(state, commit);
			row = Number(page.last_row);
		}
		this.#loaded = {
			identity: checkpoint.identity,
			row,
			state,
			pages: pages.length,
			open: undefined,
		};
		return this.#loaded;
	}

	#checkpoint(loaded: Loaded): void {
		this.#db
			.prepare(
				`INSERT INTO flue_conversation_state (singleton, identity, row, state) VALUES (1, ?, ?, ?)
				ON CONFLICT (singleton) DO UPDATE SET identity = excluded.identity, row = excluded.row, state = excluded.state`,
			)
			.run(loaded.identity, loaded.row, JSON.stringify(loaded.state));
		loaded.pages = 0;
	}

	/** Start a new cache generation at `state`: a new identity, no rows, a checkpoint. */
	#create(state: PiProjectionState): Loaded {
		this.#ensureSchema();
		const identity = ulid();
		state.storage = identity;
		const loaded: Loaded = { identity, row: 0, state, pages: 0, open: undefined };
		this.#db.transaction(() => {
			this.#db.exec('DELETE FROM flue_conversation_log');
			this.#checkpoint(loaded);
		});
		this.#loaded = loaded;
		return loaded;
	}

	/**
	 * Follow `harness`'s commits from now on. Call right after `Harness.open`,
	 * before anything commits on the root conversation. When the database holds
	 * Pi state but no usable cache, rebuild the cache from Pi reads first.
	 */
	async attach(harness: Harness, storage: Storage, context: Context): Promise<void> {
		this.#detach?.();
		this.#loaded = undefined;
		this.#attached = { harness, storage };
		if (!this.#load()) await this.#rebuild(context);
		this.#detach = harness.subscribeCommits((publication) => this.#observe(publication));
	}

	/** A cache generation over Pi as it stands: rebuilt from reads, or empty before the root exists. */
	#rebuild(context: Context = BACKGROUND_CONTEXT): Promise<Loaded | undefined> {
		const attached = this.#attached;
		if (!attached) return Promise.resolve(undefined);
		this.#rebuilding ??= (async () => {
			const rebuilt = await rebuildProjectionState(
				attached.harness,
				attached.storage,
				this.#now(),
				context,
			);
			if (!rebuilt) return this.#create(initialProjectionState());
			const loaded = this.#create(rebuilt);
			const snapshot = projectPiSnapshot(loaded.state);
			if (snapshot) {
				this.#append(
					loaded,
					[
						{
							type: 'conversation-reset',
							conversationId: snapshot.conversationId,
							snapshot,
							position: { batch: loaded.state.seq, index: 0 },
						},
					],
					undefined,
				);
			}
			return loaded;
		})().finally(() => {
			this.#rebuilding = undefined;
		});
		return this.#rebuilding;
	}

	/** Stop following Pi. Partials still buffered are written first. */
	detach(): void {
		this.#detach?.();
		this.#detach = undefined;
		this.#attached = undefined;
		const loaded = this.#loaded;
		if (loaded?.open) {
			try {
				this.#closePage(loaded);
			} catch (error) {
				this.#options.onReport?.(error);
			}
		}
		this.#loaded = undefined;
		this.#wake();
	}

	/** One Pi commit: fold, buffer or store it, notify readers. Must not throw. */
	#observe(publication: CommitPublication): void {
		try {
			// No cache while a rebuild runs or after a failure: the rebuild reads Pi as it stands.
			const loaded = this.#rebuilding ? undefined : (this.#loaded ?? this.#load());
			if (!loaded) return;
			const commit = projectionCommitOf(loaded.state, publication, this.#now());
			if (!commit) return;
			const chunks = projectPiCommitInPlace(loaded.state, commit);
			this.#append(loaded, chunks, commit);
		} catch (error) {
			// The cache no longer matches Pi: the next read rebuilds it.
			this.#loaded = undefined;
			try {
				this.#ensureSchema();
				this.#db.exec('DELETE FROM flue_conversation_state');
			} catch {}
			this.#options.onReport?.(error);
		}
	}

	#append(
		loaded: Loaded,
		chunks: ConversationStreamChunk[],
		commit: ProjectionCommit | undefined,
	): void {
		loaded.row += 1;
		const row: Row = [loaded.row, chunks];
		if (commit && isPartial(loaded.state, commit, chunks)) {
			if (!loaded.open) {
				// The page is open in SQLite before anything is buffered: a cold
				// start that finds it open knows partials were lost.
				loaded.open = { first: loaded.row, rows: [], folded: [] };
				this.#db
					.prepare(
						"INSERT INTO flue_conversation_log (first_row, last_row, closed, page, folded) VALUES (?, ?, 0, '[]', '[]')",
					)
					.run(loaded.row, loaded.row);
			}
			loaded.open.rows.push(row);
			loaded.open.folded.push(commit);
			if (loaded.open.rows.length >= PAGE_ROWS) this.#closePage(loaded);
		} else if (loaded.open) {
			loaded.open.rows.push(row);
			if (commit) loaded.open.folded.push(commit);
			this.#closePage(loaded);
		} else {
			this.#writePage(loaded, {
				first: loaded.row,
				rows: [row],
				folded: commit ? [commit] : [],
			});
		}
		this.#wake();
	}

	#closePage(loaded: Loaded): void {
		const open = loaded.open;
		if (!open) return;
		loaded.open = undefined;
		this.#writePage(loaded, open);
	}

	/** Write one closed page; every {@link CHECKPOINT_EVERY}th also checkpoints, atomically. */
	#writePage(loaded: Loaded, page: OpenPage): void {
		const last = page.rows.at(-1)?.[0] ?? page.first;
		const write = () => {
			this.#db
				.prepare(
					`INSERT INTO flue_conversation_log (first_row, last_row, closed, page, folded) VALUES (?, ?, 1, ?, ?)
					ON CONFLICT (first_row) DO UPDATE SET last_row = excluded.last_row, closed = 1, page = excluded.page, folded = excluded.folded`,
				)
				.run(page.first, last, JSON.stringify(page.rows), JSON.stringify(page.folded));
			loaded.pages += 1;
			if (loaded.pages >= CHECKPOINT_EVERY && !loaded.open) this.#checkpoint(loaded);
		};
		if (loaded.pages + 1 >= CHECKPOINT_EVERY) this.#db.transaction(write);
		else write();
	}

	#wake(): void {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const waiter of waiters) waiter();
	}

	/** The cache, opening the instance first when Pi state exists without one. */
	async #ready(): Promise<Loaded | undefined> {
		if (this.#rebuilding) return this.#rebuilding;
		const loaded = this.#load();
		if (loaded) return loaded;
		if (this.#attached) return this.#rebuild();
		if (!this.#options.open || !hasPiState(this.#db)) return undefined;
		await this.#options.open();
		return this.#load() ?? this.#rebuild();
	}

	#offset(loaded: Loaded, row: number): string {
		return `${loaded.identity}-${pad(row)}`;
	}

	/** The row an offset of this cache names; `undefined` for another identity or a malformed one. */
	#rowOf(loaded: Loaded, offset: string): number | undefined {
		if (offset === STREAM_START) return 0;
		const at = offset.lastIndexOf('-');
		if (at <= 0 || offset.slice(0, at) !== loaded.identity) return undefined;
		const row = Number(offset.slice(at + 1));
		return Number.isSafeInteger(row) && row >= 0 && row <= loaded.row ? row : undefined;
	}

	async meta(_signal?: AbortSignal): Promise<ConversationSourceMeta | null> {
		const loaded = await this.#ready();
		if (!loaded?.state.rootCreated) return null;
		return { nextOffset: this.#offset(loaded, loaded.row), incarnation: loaded.identity };
	}

	async head(_signal?: AbortSignal): Promise<ConversationHead> {
		const loaded = await this.#ready();
		if (!loaded) {
			return {
				snapshot: undefined,
				liveTargets: new Set(),
				offset: STREAM_START,
				incarnation: 'pending',
			};
		}
		const offset = this.#offset(loaded, loaded.row);
		return {
			snapshot: projectPiSnapshot(loaded.state, offset),
			liveTargets: projectPiLiveTargets(loaded.state),
			offset,
			incarnation: loaded.identity,
		};
	}

	async read(
		from: string,
		options: {
			readonly live?: 'long-poll';
			readonly signal?: AbortSignal;
			readonly resetWindow?: ResetWindowProjector;
		} = {},
	): Promise<ConversationRead | 'aborted'> {
		let loaded = await this.#ready();
		if (!loaded) return { chunks: [], nextOffset: from, upToDate: true };
		let after = this.#rowOf(loaded, from);
		if (after === undefined) return this.#rehydrate(loaded, options.resetWindow);
		if (after === loaded.row && options.live === 'long-poll') {
			if ((await this.#waitForRow(after, options.signal)) === 'aborted') return 'aborted';
			const current = this.#load();
			if (!current) return { chunks: [], nextOffset: from, upToDate: true };
			if (current.identity !== loaded.identity)
				return this.#rehydrate(current, options.resetWindow);
			loaded = current;
			after = this.#rowOf(loaded, from) ?? loaded.row;
		}
		// The written page holding row `after + 1` and the ones after it: a range of the primary key.
		const pages = this.#db
			.prepare(
				`SELECT page FROM flue_conversation_log
				WHERE closed = 1 AND last_row > ?
					AND first_row >= (SELECT coalesce(max(first_row), 0) FROM flue_conversation_log WHERE first_row <= ?)
				ORDER BY first_row LIMIT ?`,
			)
			.all<{ page: string }>(after, after + 1, READ_PAGES);
		const rows: Row[] = [];
		for (const page of pages) rows.push(...(JSON.parse(page.page) as Row[]));
		// The open page is in memory only, after every written one.
		if (pages.length < READ_PAGES && loaded.open) rows.push(...loaded.open.rows);
		const liveTargets = options.resetWindow ? projectPiLiveTargets(loaded.state) : undefined;
		const chunks: ConversationStreamChunk[] = [];
		let last = after;
		for (const [row, rowChunks] of rows) {
			if (row <= after) continue;
			last = row;
			for (const chunk of rowChunks) {
				chunks.push(
					chunk.type === 'conversation-reset' && options.resetWindow && liveTargets
						? { ...chunk, snapshot: options.resetWindow(chunk.snapshot, liveTargets) }
						: chunk,
				);
			}
		}
		return {
			chunks,
			nextOffset: this.#offset(loaded, last),
			upToDate: last >= loaded.row,
		};
	}

	/** Resolve once a row after `row` exists, the signal aborts, or {@link LONG_POLL_MS} passes. */
	#waitForRow(
		row: number,
		signal: AbortSignal | undefined,
	): Promise<'row' | 'timeout' | 'aborted'> {
		if (signal?.aborted) return Promise.resolve('aborted');
		if ((this.#loaded?.row ?? row) > row) return Promise.resolve('row');
		return new Promise((resolve) => {
			const done = (outcome: 'row' | 'timeout' | 'aborted') => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				this.#waiters.delete(onRow);
				resolve(outcome);
			};
			const onRow = () => done('row');
			const onAbort = () => done('aborted');
			const timer = setTimeout(() => done('timeout'), LONG_POLL_MS);
			this.#waiters.add(onRow);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}

	/** An offset this cache did not mint: re-hydrate from the head. */
	#rehydrate(loaded: Loaded, resetWindow: ResetWindowProjector | undefined): ConversationRead {
		const offset = this.#offset(loaded, loaded.row);
		const snapshot = projectPiSnapshot(loaded.state, offset);
		if (!snapshot) return { chunks: [], nextOffset: offset, upToDate: true };
		const chunk: ConversationStreamChunk = {
			type: 'conversation-reset',
			conversationId: snapshot.conversationId,
			snapshot: resetWindow ? resetWindow(snapshot, projectPiLiveTargets(loaded.state)) : snapshot,
			position: { batch: loaded.state.seq, index: 0 },
		};
		return { chunks: [chunk], nextOffset: offset, upToDate: true };
	}
}

// ─── Rebuild from Pi reads ───────────────────────────────────────────────────

async function scanAll<T>(
	scan: (
		cursor: Cursor | undefined,
	) => Promise<{ readonly items: readonly T[]; readonly next?: Cursor }>,
): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

type ToolCallBlock = { type?: string; id?: string };

/**
 * The projection state of the root conversation as Pi holds it now, or
 * `undefined` without a root conversation. Pi keeps no per-commit history of
 * its live document, so the fold is driven by synthesized commits: one per
 * root entry, with each run's `pi.live` reconstructed from which inputs share
 * an answer, and every submission's final record at the end. The snapshot it
 * yields is the conversation's; the stream positions it would have produced
 * are not kept — the cache serves it as one `conversation-reset`.
 */
export async function rebuildProjectionState(
	harness: Harness,
	storage: Storage,
	at: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<PiProjectionState | undefined> {
	const root = await harness.conversation(ROOT_CONVERSATION_ID, context);
	if (!root) return undefined;
	const submissions = await scanAll<SubmissionRecord>((cursor) =>
		storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor, context),
	);
	const entries = (
		await scanAll<EntryRecord>((cursor) => root.entries({}, 256, cursor, context))
	).reverse();
	const runs = await harness.snapshot(FlueRuns, ROOT_CONVERSATION_ID as ConversationId, context);
	const live = await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID as ConversationId, context);

	const docs: ProjectionChange[] = [];
	for (const submission of submissions) {
		if (submission.type !== 'input' || submission.requestId === undefined) continue;
		const receipt = await harness.snapshot(FlueReceipts, submission.requestId, context);
		if (receipt)
			docs.push({
				type: 'doc',
				id: `rebuilt:receipt:${submission.requestId}`,
				kind: 'flue.receipts',
				key: submission.requestId,
				scope: 'session',
				value: receipt as unknown as JsonValue,
			});
	}
	if (runs)
		docs.push({
			type: 'doc',
			id: 'rebuilt:runs',
			kind: 'flue.runs',
			scope: 'root',
			value: runs as unknown as JsonValue,
		});

	// Inputs answered by one entry ran together; the lowest id started the run.
	const groups = new Map<number, number[]>();
	for (const submission of submissions) {
		if (submission.type !== 'input' || submission.status !== 'done') continue;
		const group = groups.get(submission.answer) ?? [];
		group.push(submission.id);
		groups.set(submission.answer, group);
	}
	const runOf = new Map<number, { key: number; inputs: number[]; answer?: number }>();
	for (const [answer, inputs] of groups) {
		inputs.sort((left, right) => left - right);
		for (const input of inputs) runOf.set(input, { key: inputs[0] as number, inputs, answer });
	}
	const placedAt = new Map<number, SubmissionRecord>();
	for (const submission of submissions) {
		if (submission.type === 'input' && submission.entry !== undefined) {
			placedAt.set(submission.entry, submission);
			if (!runOf.has(submission.id))
				runOf.set(submission.id, { key: submission.id, inputs: [submission.id] });
		}
	}

	const state = initialProjectionState();
	const LIVE = 'rebuilt:live';
	let seq = 0;
	const fold = (changes: ProjectionChange[]) => {
		projectPiCommitInPlace(state, { seq: ++seq, at, changes });
	};
	const setLive = (value: JsonValue): ProjectionChange => ({
		type: 'doc',
		id: LIVE,
		kind: 'pi.live',
		scope: 'root',
		value,
	});
	fold([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }, ...docs, setLive({})]);

	let current: { key: number; inputs: number[]; answer?: number } | undefined;
	let tools: { callId: string; name: string; status: string }[] | undefined;
	const liveValue = (): JsonValue =>
		({
			...(current ? { run: { taskId: current.key, inputs: current.inputs } } : {}),
			...(tools ? { tools } : {}),
		}) as JsonValue;
	for (const entry of entries) {
		const changes: ProjectionChange[] = [];
		if (entry.kind === 'pi.user') {
			const placed = placedAt.get(entry.id);
			const run = placed ? runOf.get(placed.id) : undefined;
			if (placed && run) {
				if (current?.key !== run.key) {
					current = run;
					tools = undefined;
					changes.push(setLive(liveValue()));
				}
				changes.push({
					type: 'submission',
					value: { ...placed, status: 'placed', answer: undefined } as never,
				});
			}
		}
		changes.push({ type: 'entry', value: entry as never });
		if (entry.kind === 'pi.assistant') {
			const message = (entry.model?.[0] ?? {}) as { content?: unknown };
			const calls = Array.isArray(message.content)
				? (message.content as ToolCallBlock[]).filter((block) => block?.type === 'toolCall')
				: [];
			if (calls.length > 0) {
				tools = calls.map((call) => ({
					callId: String(call.id ?? ''),
					name: '',
					status: 'running',
				}));
				changes.push(setLive(liveValue()));
			}
		} else if (entry.kind === 'pi.tool-result' && tools) {
			const callId = (entry.model?.[0] as { toolCallId?: string } | undefined)?.toolCallId;
			tools = tools.map((slot) => (slot.callId === callId ? { ...slot, status: 'done' } : slot));
			changes.push(setLive(liveValue()));
		}
		fold(changes);
		if (current?.answer === entry.id) {
			// The run answered: its inputs settle and the live run ends.
			const settled = submissions.filter((submission) => current?.inputs.includes(submission.id));
			current = undefined;
			tools = undefined;
			fold([
				...settled.map(
					(submission) => ({ type: 'submission', value: submission }) as ProjectionChange,
				),
				setLive(liveValue()),
			]);
		}
	}
	// Everything else ends as Pi holds it now.
	fold([
		...submissions.map(
			(submission) => ({ type: 'submission', value: submission }) as ProjectionChange,
		),
		setLive((live ?? {}) as unknown as JsonValue),
	]);
	state.step = undefined;
	state.round = undefined;
	return state;
}
