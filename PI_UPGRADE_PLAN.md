# PI_UPGRADE_PLAN.md — Flue on Pi 0.99.2 (Pi Durable + Chord) with an Electric-backed canonical log

Base: `658325942` on branch `p-nym-20/pi-0.99-electric`. Issues: nymph-ai/nymphai #3749 (epic), #3750 (Pi), #3751 (Electric storage), #3752 (A2A entities).
Pi reference: `v0.99.2` = `005af57d`. Between `v0.99.2` and main (`d850edee`), `packages/durable/src/types.ts`, `harness/*`, `chord`, `codemode` and `agent` are the same. The only differences are in `durable/src/storage/sqlite/*` and `mcp/src/oauth/*`. **Every SqliteStorage line reference below is to the `v0.99.2` tag**, because main has already changed that file.

## 0. Key findings that shape the design

1. **Pi Durable doesn't ship MCP, Code Mode, skills or a subagent tool as harness features.** `pi-durable` owns the harness: the durable generation/tool/compaction tasks, submissions/inbox, documents, the scheduler, and the portable `bash/read/edit/write` tools (`@earendil-works/pi-durable/tools`). The codemode and MCP *tools* live in `pi-coding-agent/src/extensions/{codemode,mcp}` (Node/TUI only; `AgentTool`, not durable). Skills are helper functions in `pi-agent-core` (`formatSkillsForSystemPrompt`, `formatSkillInvocation`, `loadSkills`). Subagents are an ownership pattern (`durable/test/examples/22-24`: owned conversation + `requestId` + `replay: "safe"`), not a built-in. So "use Pi's native semantics" means:
   - Pi owns the loop, compaction, retries, recovery, submissions/inbox, ownership/abort cascades, and durable tool replay.
   - Pi libraries own the MCP client (`pi-mcp`), the codemode grammar and declarations (`pi-codemode/source`, `/declarations`), and skill formatting (`pi-agent-core`).
   - Flue writes thin `ToolRegistration`s that follow Pi's patterns exactly.
2. **`SqliteStorage` is built to run on Durable Object SQLite.** The README says: "portable SQLite and JSONL cores ... run without Node APIs, for example ... in Cloudflare Durable Objects". It reaches the database only through the `SqliteDatabase` facade (`storage/sqlite/database.ts`: `exec/prepare/transaction/close`). `commit()` (storage.ts:196-217 @v0.99.2) runs **exactly one** `db.transaction(cb)`, and `cb` returns the committed `Seq`. `next_seq` goes up by one per commit, starting at 1 (migrations.ts:15). That makes replay deterministic.
3. **The storage contract forbids surfacing a remote failure after admission.** From pico-v5.md §Storage (~3895): "`StorageRejected` means a batch was rejected before any durable effect ... unknown failures after Storage admission remain fatal." So `commit()` can't wait on Electric and then fail. The commit has to be locally atomic (index plus outbox), and publishing to Electric has to happen asynchronously.
4. **Durable Streams gives two fences.** `Producer-Id/Epoch/Seq` deduplicates within an epoch: a retry gets 204, a zombie gets 403, a gap gets 409 with `Producer-Expected-Seq`. `Stream-Seq` is a lexicographic per-stream writer sequence that returns 409 on regression. It is checked *after* producer dedup (durable-streams-rust `handlers.rs:1082`), so it still deduplicates after an epoch bump. On JSON streams, one POST is atomic and a top-level array flattens into several messages (PROTOCOL.md §9.1.2). Offsets are opaque, lexicographically sortable strings (§8). Webhook subscriptions exist (§6-7.1, Ed25519-signed, `{done:true}` or callback acks). The Rust server caps the body at 1 GiB (`api.rs:67`).
5. **The pi-codemode host can't be replaced from outside** (details in §5).
6. **Flue already has most of the needed seams.**
   - `ConversationStreamStore` already carries producer id/epoch/seq and atomic batch append (`runtime/conversation-stream-store.ts:64-118`).
   - The SDK already speaks Durable Streams with opaque string offsets. Only the runtime parses offsets.
   - The public wire is already a **projection** (`conversation-public.ts:38-205`: snapshot + `ConversationStreamChunk`), not the canonical records.

## 1. Module inventory and verdicts (`packages/runtime/src`)

Verdicts: **K** = keep (maybe re-plumbed), **W** = thin-wrap onto Pi, **D** = delete (Pi replacement named).

| Module | Verdict | Replacement / note |
|---|---|---|
| `session.ts` (6102) | **W** | Becomes a roughly 800-line `FlueSession` facade over `FluePiHost`. What goes: the loop (`new Agent` at :2274, `runModelTurnWithRecovery` :4955, transient retry :248/:672/:5089), compaction (:5118-5327), tool-batch repair/resume (:2839-3640), the canonical writer (:875-937), join/steer machinery (:1734-1850), and the task/subagent runtime (:4368-4592). Pi owns all of these: the `GenerationTask`/`ToolTask`/`CompactionTask` built-ins, `ConversationRetryPolicy`, `ToolRegistration.replay`, the inbox `whenBusy: steer\|followUp`, and owned conversations. What stays: the `prompt/skill/task/shell/compact/abort/settle/close` signatures (:2777-3828), the `CallHandle` shapes, and event emission. |
| `harness.ts` (516) | **W** | The `FlueHarness` facade. Named sessions map to ownerless Pi conversations, tracked in the `flue.sessions` session doc. |
| `agent.ts` (760) | **W/D** | `read/write/edit/bash` (:100-395) are **D**, replaced by `createReadTool/createWriteTool/createEditTool/createBashTool` from `@earendil-works/pi-durable/tools` over a Flue `ExecutionEnv`. `grep/glob` (:520-640) are **K**, re-registered as `ToolRegistration`. `task` (:395) is **D**, replaced by the Pi subagent pattern (`pi/subagent-tool.ts`). `activate_skill` (:425) is **W**, using `formatSkillInvocation`. |
| `compaction.ts` (754) | **D** | Replaced by Pi `CompactionTask` + `Conversation.setCompaction(CompactionPolicy)` + the `CompactionHooks.beforeCompact` hook. About 40 lines of settings mapping move into `pi/config.ts`. |
| `mcp.ts` (394) | **W** | The declaration resolution and connection cache (`createMcpConnectionCache`) stay. The `@modelcontextprotocol/client` transport and client are replaced by `McpClient` + `StreamableHttpTransport` + `toLlmContent` from `@earendil-works/pi-mcp`. The `@modelcontextprotocol/client` dependency is dropped. |
| `mcp-types.ts`, `hooks/use-mcp-connection.ts` | **K** | Public surface. |
| `skill-definition.ts`, `skill-frontmatter.ts`, `skill-package.ts`, `context.ts` (AGENTS.md / .agents/skills discovery) | **K** | Authoring and packaging. The catalog renders through the `registry.systemPrompt.section("flue.skills", …)` using `formatSkillsForSystemPrompt`. |
| `tool.ts`, `tool-types.ts`, `tool-entrypoint.ts`, `schema.ts` | **K** | Public `defineTool`. |
| `tool-adapter.ts` | **W** | Converts Flue `ToolDefinition` to Pi `ToolRegistration`. `durable: true` maps to `replay: "safe"` plus `api.memo` for steps. |
| `result.ts` (368) | **W** | Result tools become `ToolRegistration` with `control: { terminate: true }`. The result is read from the tool-result entry details. |
| `harness-tool-lineage.ts` | **D** | Delegation depth comes from the Pi conversation `owner` chain (`MAX_DELEGATION_DEPTH`, session.ts:247). |
| `abort.ts` | **W** | Maps to `Harness.abortSubmission` / `Conversation.abort`. |
| `shell.ts`, `sandbox.ts`, `cloudflare/cf-sandbox.ts` | **K** | Plus a new `pi/execution-env.ts` adapter from `SandboxDriver` (sandbox.ts:348) to Pi `ExecutionEnv`. |
| `conversation-records.ts` (473) | **D** (after legacy import) | Replaced by Pi `StorageWrite`/`EntryRecord`. Kept under `legacy/` for the import only. |
| `conversation-reducer.ts` (1584) | **D** (after legacy import) | Replaced by Pi records/documents. Moved to `legacy/` and used only to import pre-upgrade streams. |
| `conversation-writer.ts` (431), `conversation-reader.ts` | **D** | Replaced by `StreamStorage` and `pi/projection.ts`. |
| `conversation-projections.ts`, `conversation-public.ts` | **K types / W functions** | The wire types are unchanged. The projection is re-derived from Pi commits (§4). |
| `conversation-fold-host.ts`, `conversation-fold-checkpoint.ts` | **K** (re-typed) | A cache over the Pi log, with opaque offsets. |
| `submission-state.ts`, `runtime/settlement-rebuild.ts` | **D** | Replaced by Pi `SubmissionRecord` lifecycle and `Harness.inspect()`. |
| `runtime/agent-submissions.ts` (1409) | **W** | Admission keeps `admitInstanceContact` (:206), `ensureInstanceIdentity` (:291), `adoptKeyedSubmissionReplay`/`sameSubmissionIdentity` (:390-437) and attachment materialization (:439), now over `pi/receipts.ts`. `processSubmission` (:820), `reconcileInterruptedSubmission` (:489), attempts/leases and joins (:1007-1386) are **D**: Pi task recovery plus inbox. |
| `agent-execution-store.ts` | **K** `PersistenceAdapter` (:420) | `AgentSubmissionStore` is deprecated: no longer written, kept one release for adapter compatibility. |
| `sql-agent-execution-store.ts`, `cloudflare/agent-execution-store.ts`, `node/agent-execution-store.ts` | **deprecate → D** | Replaced by receipts in Pi docs. |
| `runtime/conversation-stream-store.ts` | **K** | The adapter contract, because five external adapters implement it (postgres, mysql, mongodb, redis, libsql). It gets bridged to `DurableStreamLog`. The in-memory implementation stays. |
| `runtime/sql-conversation-stream-store.ts`, `sql-persisted-chunk-store.ts`, `sql-storage.ts` | **K** | The self-hosted log for non-Electric deployments. |
| `runtime/stream-offsets.ts` | **K**, narrowed | `formatOffset`/`parseOffset` become helpers for *stores that mint their own offsets* only (redis/mongodb use them internally). The runtime core stops calling them. |
| `runtime/conversation-observer.ts` | **W** | Observes the Pi projection. `batchOrdinal` (:65) becomes the Pi `seq`. |
| `runtime/handle-conversation-routes.ts` | **K** (protocol) | Its source becomes the Pi projection. Remove `parseOffset` at :207 and :285. |
| `runtime/conversation-history-window.ts`, `runtime-activity-gate.ts`, `dev-lifecycle-logger.ts`, `events.ts`, `schemas.ts`, `message-input.ts`, `attachment-store.ts`, `sql-attachment-store.ts` | **K** | |
| `runtime/dispatch.ts`, `dispatch-queue.ts`, `ids.ts` (frozen `deriveKeyedSubmissionId` :96), `flue-app.ts`, `agent-routes.ts`, `channel-routes.ts`, `handle-agent.ts`, `registration.ts` | **K** | Public dispatch, receipts, channels and routing. |
| `runtime/providers.ts`, `builtin-providers.ts` | **K** | Build the pi-ai `Models` passed to `HarnessOptions.models`. |
| `cloudflare/workers-ai-provider.ts` (1491), `anthropic-binding-request.ts`, `gateway.ts` | **W** (verify) | pi-ai 0.99.2 ships `api/cloudflare-ai-binding` (`createAiBindingFetch`, `AiBinding`) and `providers/cloudflare-workers-ai`. Collapse wherever parity tests pass. Keep the `env.AI.run()` path if pi-ai still only reaches the gateway through `fetch`. |
| `cloudflare/agent-coordinator.ts` (1392) | **W** (~500) | `admitDispatch` (:1234) calls `host.admit`. `supervisorPass`/`drainSubmissions` (:337-411) call `host.wake`. `onAlarm` (:445) drains the outbox, resumes, and fires schedules. Delete reconcile/attempt/lease logic (:595-1107). |
| `cloudflare/flue-agent-class.ts` | **K** | Adds `__flueWake(streams)` RPC for webhooks. |
| `node/agent-coordinator.ts` (1341) | **W** | Same shape as the Cloudflare coordinator. |
| `hooks/*` (all `use*`) | **K** | Unchanged signatures, re-plumbed through `pi/registry-bridge.ts`, which maps render output to `registry.batch()` and `Conversation.setActiveTools/setModel/setThinkingLevel/setCompaction`. |
| `hooks/use-persistent-state.ts` | **K** | Backed by Pi doc family `flue.state`. |
| `hooks/use-data-writer.ts`, `message-output.ts` | **W** | Become entries of kind `flue.data` / `flue.metadata` (no `model`). |
| `hooks/use-subagent.ts` | **K** | Implemented by `pi/subagent-tool.ts`. |
| `hooks/use-agent-start.ts`, `use-agent-finish.ts`, `use-response-start.ts`, `use-response-finish.ts` | **K** | Wired to `GenerationHooks.beforeRequest/afterResponse/onYield/afterTools`. |
| `telemetry/*`, `instrumentation.ts`, `execution-interceptor.ts`, `observation.ts`, `event-redaction.ts`, `model-request-info.ts`, `provider-diagnostics.ts`, `usage.ts`, `message-rendering.ts`, `document-attachments.ts`, `persisted-images.ts` | **K** | Event source becomes `watchEvents()` plus the hooks. Usage is read from `UsageDoc`. |
| `format-version.ts` | **K** | Bumps the format. Pi-backed instances record the new version. |
| `test-utils/*` | **K** | Adds the log contract and runs Pi `registerStorageConformance`. |
| `packages/sdk` | **K, unchanged** | The wire contract is preserved (§4). |
| `packages/vite` | **K** | Adds a `worker_loaders` binding for Code Mode and `nodejs_compat` stubs (§6). |
| postgres/mysql/mongodb/redis/libsql | **K** | They keep implementing `ConversationStreamStore`. The Pi envelope travels as one opaque record. |

New modules: `src/pi/*` (the adapter), `src/streams/*` (log port and implementations), `src/entity/*` (A2A), `src/legacy/*`.

## 2. Adapter interfaces (TypeScript)

### 2.1 FluePiHost — the single Flue Pi adapter (`src/pi/host.ts`)

```ts
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type {
  Harness, Registry, ToolRegistration, ConversationId, SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { DispatchReceipt, DeliveredMessage } from "../types.ts";
import type { StreamStorage } from "./stream-storage.ts";
import type { DurableStreamLog } from "../streams/log.ts";
import type { CodemodeExecutor } from "./codemode/executor.ts";
import type { EntityRef } from "../entity/services.ts";

export interface FluePiHostOptions {
  readonly entity: EntityRef;                 // { type: agentName, id: instanceId }
  readonly models: Models;                    // runtime/providers.ts
  readonly env: ExecutionEnv;                 // pi/execution-env.ts over Flue Sandbox
  readonly storage: () => Promise<StreamStorage>;
  readonly streams: DurableStreamLog;         // for inbox/events/observe (A2A)
  readonly codemode?: CodemodeExecutor;       // DW executor on CF, CodemodeSandbox on Node
  readonly now?: () => number;
  readonly onReport: (error: unknown) => void;
  readonly armWake: (atMs: number, reason: WakeReason) => Promise<void>; // DO alarm / node timer
}

export type WakeReason =
  | { kind: "outbox" } | { kind: "live-tasks" } | { kind: "schedule"; scheduleId: string }
  | { kind: "inbox"; stream: string; tailOffset: string } | { kind: "dispatch" };

export interface FlueAdmission {
  readonly submissionId: string;              // sub_… or sub_ik_… (frozen derivation)
  readonly kind: "dispatch" | "direct";
  readonly session?: string;                  // Flue named session; default root
  readonly message: DeliveredMessage;
  readonly initialData?: unknown;
  readonly uid?: string | null;               // send condition
  readonly acceptedAt: string;
  readonly whenBusy: "steer" | "followUp";    // Flue join ⇒ steer
  readonly limits?: { readonly timeoutAt?: number; readonly maxAttempts?: number };
  readonly traceCarrier?: Record<string, string>;
}

export interface FlueSettlement {
  readonly submissionId: string;
  readonly outcome: "completed" | "failed" | "aborted";
  readonly answerEntryId?: number;
  readonly answeredBySubmissionId?: string;
  readonly error?: { message: string; detail?: unknown };
  readonly result?: unknown;                  // structured result tool payload
  readonly settledAt: string;
}

export interface FluePiHost {
  readonly harness: Harness;
  readonly registry: Registry<ToolRegistration>;
  open(context: Context): Promise<void>;          // storage open/rebuild → render → Harness.open → resume
  applyRender(render: RenderedAgent, context: Context): Promise<void>; // hooks → registry.batch + conversation config
  conversation(session: string | undefined, context: Context): Promise<ConversationId>;
  admit(input: FlueAdmission, context: Context): Promise<DispatchReceipt>;
  settlement(submissionId: string, context: Context): Promise<FlueSettlement | undefined>;
  waitForSettlement(submissionId: string, context: Context): Promise<FlueSettlement>;
  abort(submissionId: string | undefined, context: Context): Promise<boolean>;
  wake(reason: WakeReason, context: Context): Promise<void>;   // drains outbox/inbox, fires schedules, resume()
  close(context: Context): Promise<void>;
}

/** Hook render output that the registry bridge consumes (from hooks/render.ts). */
export interface RenderedAgent {
  readonly model?: { provider: string; modelId: string };
  readonly thinkingLevel?: string;
  readonly instructions: readonly { key: string; text: string }[];
  readonly tools: readonly ToolRegistration[];
  readonly skills: readonly { name: string; description: string; content: string; filePath: string }[];
  readonly compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number };
  readonly mcp: readonly McpConnectionDeclaration[];
  readonly subagents: readonly SubagentDeclaration[];
}
```

Flue-owned documents and entries (`src/pi/docs.ts`), all Pi `defineDoc`/`defineDocFamily`/`defineEntry`:

- `flue.instance` (session): `{ uid, createdAt, initialData? }`
- `flue.receipts` (session family, key = Flue `submissionId`): `{ piSubmissionId?, conversationId, kind, digest, acceptedAt, uid, status: "admitting"|"admitted", timeoutAt?, maxAttempts?, attempts, classification? }`
- `flue.sessions` (session): `{ [name]: ConversationId }`
- `flue.state` (conversation family): `usePersistentState`
- `flue.schedules` (session family)
- `flue.observations` (session family)
- Entries: `flue.data`, `flue.metadata`, `flue.a2a.send`, `flue.publish`

### 2.2 Canonical log port (`src/streams/log.ts`)

```ts
declare const offsetBrand: unique symbol;
/** Opaque Durable Streams offset; only compare with compareOffsets(). */
export type StreamOffset = string & { readonly [offsetBrand]: true };
export const STREAM_START = "-1" as StreamOffset;
export const STREAM_NOW = "now" as StreamOffset;
export const compareOffsets = (a: StreamOffset, b: StreamOffset): number =>
  a === b ? 0 : a === STREAM_START ? -1 : b === STREAM_START ? 1 : a < b ? -1 : 1; // PROTOCOL §8(2)

export interface ProducerClaim { readonly id: string; readonly epoch: number; readonly seq: number }

export type AppendOutcome =
  | { readonly status: "appended"; readonly nextOffset: StreamOffset }
  | { readonly status: "duplicate"; readonly nextOffset?: StreamOffset }          // 204 in-epoch dup
  | { readonly status: "stream-seq-conflict"; readonly nextOffset?: StreamOffset } // 409 "Sequence conflict": already appended under an earlier epoch
  | { readonly status: "fenced"; readonly currentEpoch: number }                   // 403
  | { readonly status: "producer-gap"; readonly expectedSeq: number }              // 409 + Producer-Expected-Seq
  | { readonly status: "retryable"; readonly error: unknown };                     // network/5xx/429

export interface ReadBatch {
  readonly messages: readonly unknown[];      // JSON messages (application/json streams)
  readonly nextOffset: StreamOffset;          // Stream-Next-Offset
  readonly upToDate: boolean;
  readonly closed: boolean;
  readonly cursor?: string;                   // Stream-Cursor (live)
}

export interface DurableStreamLog {
  ensure(path: string, signal?: AbortSignal): Promise<{ readonly nextOffset: StreamOffset }>; // PUT (idempotent)
  append(path: string, input: {
    readonly messages: readonly unknown[];    // one POST ⇒ atomic; array flattened into messages
    readonly producer: ProducerClaim;
    readonly streamSeq?: string;              // Stream-Seq, zero-padded Pi seq
  }, signal?: AbortSignal): Promise<AppendOutcome>;
  read(path: string, from: StreamOffset, options?: {
    readonly live?: false | "long-poll" | "sse"; readonly cursor?: string; readonly signal?: AbortSignal;
  }): Promise<ReadBatch>;
  head(path: string, signal?: AbortSignal): Promise<{ readonly nextOffset: StreamOffset; readonly closed: boolean } | null>;
  subscribe?(path: string, listener: () => void): () => void; // in-process wakeups (memory/SQL)
}
```

Implementations:

- `streams/memory-log.ts`: `InMemoryDurableStreamLog`. Implements the producer and Stream-Seq rules from PROTOCOL §5.2/5.2.1 exactly and mints its own offsets. It is the test double.
- `streams/store-bridge-log.ts`: `conversationStreamStoreLog(store: ConversationStreamStore)`. Maps onto `createStream/acquireProducer/append/read/getMeta/subscribe` (conversation-stream-store.ts:64-118). The SQL store and the five external adapters work unchanged, since the envelope rides as a single record.
- `streams/electric-log.ts`: `ElectricDurableStreamLog({ baseUrl, fetch, headers })`. `PUT` with `Content-Type: application/json`; `POST` with `Producer-Id/Producer-Epoch/Producer-Seq/Stream-Seq`; `GET ?offset=&live=long-poll|sse&cursor=`; `HEAD`. Status mapping: 200 → appended, 204 → duplicate, 403 → fenced (reads the `Producer-Epoch` header), 409 → `Producer-Expected-Seq` present ? producer-gap : "Sequence conflict" body ? stream-seq-conflict : error, 413 → split error. It is fetch-only, so it runs on workerd.
- `streams/outbox-log.ts`: `OutboxDurableStreamLog(inner, sql)`. The DO-SQLite outbox and fence in front of a remote log. `enqueueSync()` is only callable inside a DO SQLite transaction. `drain()` publishes rows in order.

### 2.3 StreamStorage — Pi `Storage` over the log (`src/pi/stream-storage.ts`)

```ts
import type { Context } from "@earendil-works/chord";
import type { Storage, StorageWrite, Seq } from "@earendil-works/pi-durable";
import { SqliteStorage, type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";

/** One atomic Pi commit = one Durable Streams POST. */
export interface PiCommitEnvelope {
  readonly v: 1;
  readonly type: "pi.commit";
  readonly storage: string;                   // storage incarnation (ULID), detects re-created logs
  readonly seq: number;                       // Pi Seq returned by the index commit
  readonly at: number;                        // ms
  readonly writes: readonly StorageWrite[];   // exact, replayable
}
/** Present only when an envelope exceeds maxMessageBytes; all parts go in ONE POST (atomic). */
export interface PiCommitPart { readonly v: 1; readonly type: "pi.commit.part"; readonly seq: number; readonly index: number; readonly count: number; readonly chunk: string }

export interface CommitOutbox {
  /** Must be called synchronously inside the index transaction. */
  enqueueSync(envelope: PiCommitEnvelope): void;
  pending(): number;
  drain(signal?: AbortSignal): Promise<DrainResult>;  // publishes in seq order; never throws on retryable
  publishedThrough(): { seq: number; nextOffset: string } | undefined;
}
export type DrainResult = { status: "idle" | "published" | "backoff"; retryAt?: number } | { status: "fenced"; currentEpoch: number };

/** SqliteDatabase facade whose transaction also writes the outbox row atomically. */
export interface FencedSqliteDatabase extends SqliteDatabase {
  armCommit(writes: readonly StorageWrite[]): void;   // consumed by the next transaction() whose callback returns a Seq
  disarm(): void;
}

export interface StreamStorageOptions {
  readonly database: FencedSqliteDatabase;    // DO: ctx.storage.sql + transactionSync; Node: node:sqlite
  readonly outbox: CommitOutbox;
  readonly log: DurableStreamLog;
  readonly path: string;                      // flue/v1/{agent}/{instance}/pi
  readonly publish: "async" | "await";        // default async (see §2.4)
  readonly onFenced: (epoch: number) => void; // poison the host
}

export declare class StreamStorage implements Storage {
  static open(options: StreamStorageOptions, context: Context): Promise<StreamStorage>; // migrations → rebuild-if-empty → drain
  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;
  mintId: Storage["mintId"];
  // every read is delegated to the SqliteStorage index (a materialized cache of the log):
  conversation: Storage["conversation"]; scanConversations: Storage["scanConversations"];
  entry: Storage["entry"]; findLatestHeadMarker: Storage["findLatestHeadMarker"]; scanEntries: Storage["scanEntries"];
  task: Storage["task"]; scanTasks: Storage["scanTasks"];
  submission: Storage["submission"]; scanSubmissions: Storage["scanSubmissions"]; submissionByRequest: Storage["submissionByRequest"];
  findDocument: Storage["findDocument"]; document: Storage["document"]; scanDocuments: Storage["scanDocuments"];
  close(context: Context): Promise<void>;
  /** Drop the index and replay the log; asserts replayed seq === envelope.seq for every commit. */
  rebuild(context: Context): Promise<void>;
}
```

### 2.4 Commit protocol, outbox and fence

DO SQLite tables (a `flue_` prefix, so there is no collision with Pi's `conversations/entries/tasks/submissions/documents/document_revisions/durable_*` or `cf_agents_*`):

```sql
CREATE TABLE flue_pi_outbox   (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, producer_seq INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE flue_pi_producer (path TEXT PRIMARY KEY, producer_id TEXT NOT NULL, epoch INTEGER NOT NULL,
                               next_producer_seq INTEGER NOT NULL, published_seq INTEGER NOT NULL,
                               published_offset TEXT, storage_incarnation TEXT NOT NULL);
CREATE TABLE flue_pi_offsets  (seq INTEGER PRIMARY KEY, next_offset TEXT NOT NULL);   -- Pi seq → Electric offset (cache)
CREATE TABLE flue_relay_outbox(id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL,
                               producer_id TEXT NOT NULL, producer_seq INTEGER NOT NULL);  -- A2A send / publish fan-out
```

`commit(writes)`:

1. `database.armCommit(writes)`, then `seq = await index.commit(writes)` (the Pi `SqliteStorage`). Inside SqliteStorage's single `db.transaction(cb)` (storage.ts:200 @v0.99.2), the facade runs `ctx.storage.transactionSync(() => { const r = cb(); if (armed) { assertSeq(r); outbox.enqueueSync({v:1,type:"pi.commit",storage,seq:r,at,writes}); relay.enqueueSync(r, writes); } return r; })`. The index rows, outbox row, and relay rows commit **in one DO SQLite transaction**. `producer_seq = next_producer_seq++` is assigned in the same transaction. `disarm()` runs in `finally` (SqliteStorage may throw from `prepareDocumentActions` before it opens the transaction).
2. Resolve `seq`. Pi's contract ("later reads observe it") holds because reads go to the index. Then `drain()` is kicked without being awaited. `publish: "await"` exists for tests and strict mode, and waits for the drain up to a deadline without ever turning a publish error into a commit error (finding 3).
3. `drain()` runs one POST per outbox row in seq order, with `Producer-Id = "{agent}/{instance}/pi"`, `Producer-Epoch = epoch`, `Producer-Seq = producer_seq`, and `Stream-Seq = seq.toString().padStart(16,"0")`:
   - `appended`/`duplicate`: delete the row, set `published_seq/offset`, insert into `flue_pi_offsets`.
   - `stream-seq-conflict`: the commit already landed under an earlier epoch, so treat it as `duplicate`.
   - `producer-gap` with expected > ours: the earlier rows landed but their acks were lost, so delete rows below expected and continue. Expected < ours can't happen and is treated as corruption: bump the epoch (below).
   - `fenced`: another writer holds a higher epoch. Call `onFenced`, which poisons the host (close the Harness, fail requests, stop draining). This is the zombie DO / split-brain guard.
   - `retryable`: exponential backoff, and `armWake(retryAt, {kind:"outbox"})`.
4. **Epoch policy.** The epoch is persisted and not bumped on DO restart, so restart retries deduplicate within the epoch. It is bumped (seq resets to 0) only when (a) the index is rebuilt on a fresh DO or after the cache is discarded, or (b) the server lost producer state (a `producer-gap` claiming expected < ours). Across an epoch bump, `Stream-Seq` is what prevents a duplicate semantic commit.

Crash matrix (the #3751 acceptance criteria):

- **Crash before the local transaction:** nothing is durable, and Pi saw no resolution.
- **Crash after the local transaction, before the POST:** the outbox row survives, and `open()`/alarm drain it. No duplicate, because the Pi commit happened exactly once.
- **Crash after the POST was appended, before the local ack:** the retry gets 204 (same epoch) or "Sequence conflict" (after an epoch bump). Both count as published.
- **Replay:** `rebuild()` reads the log from `-1`, reassembles parts, and calls `index.commit(env.writes)` in order, asserting that the returned seq equals `env.seq`. SqliteStorage mints seqs deterministically from 1, and `candidateNextId` recomputes `next_id`. So the rebuilt Pi Durable state is identical. Minted-but-never-committed IDs may be reissued, which is legal because they were never persisted.
- **Cache semantics:** the SqliteStorage tables and every Flue fold/projection checkpoint are caches. `rebuild()` and `flue_pi_offsets` are regenerable.

### 2.5 Chord services for entity operations (`src/entity/services.ts`)

```ts
import { defineService, type Context, type JsonValue, type ReplicatedState } from "@earendil-works/chord";

export type EntityRef = { readonly type: string; readonly id: string };         // Flue agent name + instance id ⇒ DO idFromName
export type EntityMessage = { readonly text?: string; readonly data?: JsonValue; readonly attachments?: JsonValue[] }; // JSON form of DeliveredMessage
export type SendReceipt = { readonly messageId: string; readonly submissionId: string; readonly deduplicated: boolean };
export type ObserveSource = { readonly entity: EntityRef; readonly channel: "events" } | { readonly stream: string };
export type ObservedBatch = { readonly items: readonly JsonValue[]; readonly nextOffset: string; readonly upToDate: boolean };

export interface EntityMessagingService {
  /** Durable; lands in target inbox via the relay outbox; target admits with requestId = submissionId. */
  send(target: EntityRef, message: EntityMessage, options: { readonly messageId?: string }, context: Context): Promise<SendReceipt>;
  /** Transactional publish to this entity's public events stream. */
  publish(event: JsonValue, options: { readonly eventId?: string }, context: Context): Promise<{ readonly eventId: string }>;
}
export interface EntityObservationService {
  observe(source: ObserveSource, options: { readonly key: string; readonly from?: string; readonly wake?: boolean }, context: Context): Promise<{ readonly key: string; readonly offset: string }>;
  poll(key: string, options: { readonly limit?: number }, context: Context): Promise<ObservedBatch>;
  unobserve(key: string, context: Context): Promise<void>;
  /** Read-only projection of observation cursors (replicated to UIs/remote facets). */
  readonly cursors: ReplicatedState<{ readonly [key: string]: { readonly offset: string; readonly updatedAt: number } }>;
}
export interface EntityLifecycleService {
  spawn(type: string, args: { readonly key: string; readonly initialData?: JsonValue; readonly message?: EntityMessage }, context: Context): Promise<EntityRef & { readonly uid: string }>;
  schedule(target: EntityRef, atMs: number, message: EntityMessage, options: { readonly scheduleId: string }, context: Context): Promise<{ readonly scheduleId: string }>;
  cancelSchedule(target: EntityRef, scheduleId: string, context: Context): Promise<boolean>;
}

export const EntityMessaging   = defineService<EntityMessagingService>("flue.entity.messaging");
export const EntityObservation = defineService<EntityObservationService>("flue.entity.observation");
export const EntityLifecycle   = defineService<EntityLifecycleService>("flue.entity.lifecycle");
```

All three contracts are JSON and `Context`-last, so they satisfy `RemoteServiceContract` and could be exported remotely later. Providers live in a Flue facet (`entity/facet.ts`, `defineFacet`) and use `FluePiHost` + `DurableStreamLog`. A second facet, `entity/tools-facet.ts`, `use()`s them and registers the Pi `ToolRegistration`s (`send_message`, `publish_event`, `observe`, `spawn_agent`, `schedule_wake`). Pi never sees Electric or Cloudflare.

Semantics:

- **send.** The tool commits an entry `flue.a2a.send {target, messageId, message}` inside its own Pi commit (`api.commit`). The fenced facade sees that entry kind and inserts a `flue_relay_outbox` row in the same transaction. The drainer posts it to `flue/v1/{T.type}/{T.id}/inbox` with `Producer-Id = "{self}→inbox"` and per-target contiguous `producer_seq`, assigned serially by the relay. That is exactly-once into the inbox, with receiver dedup as defense in depth. The default `messageId` is `{self}/{taskId}/{callId}`, which is stable across `replay:"safe"` reruns. The receiver derives `submissionId = deriveKeyedSubmissionId(T.type, T.id, messageId)` (ids.ts:96, a frozen format), so an A2A send **is** an idempotent dispatch.
- **Wake.** A single Electric webhook subscription with `pattern: "flue/v1/*/*/inbox"` (plus explicit observed streams) POSTs to the Worker route `/__flue/streams/wake`. The route verifies Ed25519 against the JWKS (`entity/webhook.ts`, WebCrypto) and calls `stub(idFromName(entity)).__flueWake(streams)`. The DO reads the inbox from its cursor (DO SQLite `flue_inbox_cursor`), calls `host.admit` per message (dedup by requestId), advances the cursor, and returns `processedThrough`. The Worker replies `{done:true}` when `processedThrough >= tail_offset` for every stream, and otherwise acks through the callback. The DO wakes, reconstructs its state (`StreamStorage.open` + `Harness.open`), runs Pi, and its replies go out through the same relay. That is the #3752 acceptance path.
- **observe.** Each observed item is admitted as a Pi **write** submission of entry kind `flue.observed`, with `requestId = "obs:{key}@{offset}"`. That is idempotent and the history stays replayable. The cursor lives in the `flue.observations` doc. `wake: true` adds the stream to the subscription.
- **spawn.** Deterministic child id `{parent}/{key}`, `ensure()` its streams, then admit with `uid: null` (create-only) and `initialData`. Flue's existing birth semantics (`admitInstanceContact`, agent-submissions.ts:206) apply unchanged. This is different from subagents, which stay inside one Pi Session as owned conversations.
- **schedule.** For self: the `flue.schedules` doc plus `armWake(min(at))` through the Agents SDK `schedule()`, which is already multiplexed on the DO alarm by the coordinator (`armDrain`/`armBackstop`, agent-coordinator.ts:595-613). When it fires, admit with `requestId = "sched:{id}"`. For another entity: relay a `{type:"schedule",…}` inbox message, which the target turns into its own schedule plus alarm.
- **Backstop.** While `harness.inspect().tasks` is non-empty or the outbox is non-empty, keep an alarm at 30 s or less. On each alarm, call `host.wake` → `resume()`, so Pi resumes interrupted generations and tools after eviction.

### 2.6 Other ports

```ts
// src/pi/codemode/executor.ts — result-compatible with pi-codemode (type-only import is erased)
import type { CodemodeResult, CodemodeTool, CodemodeExecuteOptions } from "@earendil-works/pi-codemode";
export interface CodemodeExecutor {
  execute(code: string, tools: readonly CodemodeTool[], options: CodemodeExecuteOptions & { timeoutMs: number; memoryLimitBytes?: number }): Promise<CodemodeResult>;
  close(): Promise<void>;
}
// src/pi/execution-env.ts
export function executionEnvFromSandbox(driver: SandboxDriver, cwd: string): ExecutionEnv;
```

## 3. Submissions, receipts and idempotency keys → Pi Durable, losslessly

| Flue | Pi Durable | Where |
|---|---|---|
| `DispatchReceipt.submissionId` (`sub_<ulid>` or `sub_ik_<hash>`) | `SubmissionDraft.requestId` (verbatim) | `admitSubmission` dedups through `tx.submissionByRequest` (harness/submissions.ts:145) |
| Pi `SubmissionId` (number) | stored in `flue.receipts[submissionId].piSubmissionId` | never exposed |
| `acceptedAt` | `flue.receipts.acceptedAt` (Pi keeps no time on submissions) | |
| `uid` / send condition (`null` = create-only, string = must match) | `flue.instance.uid`, checked in admission commit A | 404/409 raised before anything durable, as today |
| `idempotencyKey` → `sub_ik_` derivation | unchanged (ids.ts:96-107) | |
| Payload-conflict 409 (`sameSubmissionIdentity`, agent-submissions.ts:402) | `flue.receipts.digest` = SHA-256 of canonical JSON `{kind,agent,id,message,initialData}` | compared in commit A |
| `deduplicated: true` | commit A finds an existing receipt with the same digest | |
| Join into a live response (`joinedInto`) | `whenBusy: "steer"`; queued non-joins use `"followUp"` | Pi inbox boundaries |
| `answeredBySubmissionId` | the inputs settled by one run share the same `answer` entry; host = requestId of the lowest `SubmissionId` with that answer | projection |
| Settled `completed` | `status: "done"` (+ answer entry; structured result from the terminating result tool's details) | |
| Settled `aborted` | `unanswered` with reason `"aborted"` | |
| Settled `failed` | `unanswered` with any other reason (`stale`, faulted run) with `detail` | |
| `exceeded_timeout` / `exhausted_retry_budget` (agent-submissions.ts:65-72) | Flue sets `flue.receipts.classification` and **then** calls `harness.abortSubmission` or `conversation.abort`. `timeoutAt` is enforced by the DO alarm. The attempt budget counts Harness reopens that find the run live (`attempts++` in a receipt commit). | projection prefers the receipt classification |
| Attachments on `DeliveredMessage` | Bytes stay in the `AttachmentStore`. User content holds `image`/`document` placeholders `flue-attachment:<id>`, rehydrated in `GenerationHooks.beforeRequest` (request-only, per types.ts GenerationHooks) | keeps base64 out of the canonical log |

Admission takes two commits, because `admitSubmission` isn't exported and `Tx` has no inbox-aware create:

- **Commit A:** `harness.commit(tx => …)` checks the uid condition, creates `flue.instance` at birth, and upserts `flue.receipts[submissionId]` with `status:"admitting"`, or returns dedup/conflict.
- **Commit B:** `conversation.submit({type:"input", content, requestId: submissionId, whenBusy})`, then set the receipt to `admitted` with `piSubmissionId`.

A crash between A and B is repaired on the next `wake`: scan receipts with `status:"admitting"` and redo B, which is idempotent through `requestId`. A caller retry converges the same way. That makes admission at-most-once per key and never lost.

## 4. Public conversation stream: a projection, not raw envelopes

**Decision:** keep Flue's public wire format (`AgentConversationSnapshot` + `ConversationStreamChunk`, conversation-public.ts:38-205) as a **pure projection of Pi commits**. Serve it from the Flue routes (`handle-conversation-routes.ts`) with the **canonical Pi log's opaque offsets passed through** as `Stream-Next-Offset`.

Why:

1. `@flue/sdk` stays byte-compatible: no protocol fork, as #3751 requires.
2. Pi envelopes carry internal numeric IDs, task records, Chord delta ops with backend-private base/delta semantics, tool memos and full tool outputs. Serving them directly would freeze Pi internals into Flue's public API. Pi also marks `AgentEvent` as experimental (events.ts), and Harness `subscribeCommits` has an open TODO (types.ts:520).
3. The SDK's dedup `position.batch` is a number (conversation-public.ts:151-160). Pi `Seq` fits it exactly, whereas an opaque offset would not.
4. Raw envelopes stay available to trusted consumers such as Fabric ingress by reading the Electric Pi-log stream directly.

Mapping (`src/pi/projection.ts`, `projectPiCommit(state, envelope) → { state, chunks }`, with fold state cached by the existing `conversation-fold-host.ts`/`conversation-fold-checkpoint.ts` keyed by opaque offset):

| Pi | Public chunk |
|---|---|
| `pi.user` entry | `message-appended` |
| `pi.live` `generation.message` ops (Chord string-append ops) | `message-started` / `message-delta` (`text` \| `reasoning`) |
| `pi.assistant` entry | `message-completed` |
| `pi.live.tools` slot `running` | `tool-input` |
| `pi.tool-result` | `tool-output` / `tool-output-error` |
| `flue.data` / `flue.metadata` entries | `data-part` / `message-metadata` |
| `submission` write to `done`/`unanswered` | `submission-settled` (via receipts) |
| Rebuild or legacy import | `conversation-reset` plus the `stream-checkpoint` incarnation, the SDK's existing mechanism |

Chunks use `position = {batch: env.seq, index}`. The `updates` read goes to `log.read(path, clientOffset, {live})`, projects each envelope, and returns Electric's `nextOffset`. Pi flushes streaming partials at most every 100 ms (`PARTIAL_THROTTLE_MS`, generation.ts:112), so live deltas cost about 10 appends per second per streaming conversation. That is similar to Flue's current coalescing (`conversation-writer.ts`).

## 5. Code Mode on workerd

The pi-codemode host **can't be supplied without forking**:

- `runtime/host.ts:1` statically imports `Worker` from `node:worker_threads` and constructs it at :155.
- `wasm.ts:1-2` uses `node:fs/promises` and `node:module`.
- The interrupt protocol needs a `SharedArrayBuffer` plus `Atomics` (protocol.ts:24, worker.ts:60).
- The package root (`index.ts`) re-exports `CodemodeSandbox`, so importing the root pulls in `node:worker_threads`, which workerd doesn't provide.
- The `exports` map (`.`, `./declarations`, `./source`, `./worker`) blocks deep imports of `runtime/prelude-source.js`. `CodemodeSandboxOptions` only exposes `wasm` and `workerUrl`, with no executor injection.

Flue's answer, with no Pi changes:

- **Model-facing contract from Pi.** The tool description and TS declarations come from `@earendil-works/pi-codemode/declarations` (`renderDeclarations`, `schemaToType`, `MCP_TYPESCRIPT_PREAMBLE`). The source grammar and `// @options:` parsing come from `@earendil-works/pi-codemode/source` (`CODEMODE_SOURCE_GRAMMAR`, `parseCodemodeSource`). Both are pure. Result/tool types come through `import type` from the root, which is erased.
- **Executor port** (`CodemodeExecutor`, §2.6):
  - **Cloudflare:** `DynamicWorkerCodemodeExecutor` (`src/cloudflare/codemode-dynamic-worker.ts`) uses the Worker Loader binding (`env.LOADER.get(id, () => ({ mainModule, modules, compatibilityDate, globalOutbound: null, env: { HOST: rpcStub } }))`). The model's script runs natively in a fresh isolate with no network. Tools are RPC calls back through a `WorkerEntrypoint` stub. Flue ships a prelude that reproduces the Pi script ABI (`tools`, `ALL_TOOLS`, `text`, `image`, `exit`, `store`/`load` with `MAX_STORE_*` limits, `console`), with timeouts through `AbortSignal` and isolate CPU limits.
  - **Node:** `NodeCodemodeExecutor` wraps `CodemodeSandbox` directly.
- **Conformance.** One script corpus runs against both executors and must produce equal `CodemodeResult`s. That catches drift from the Pi prelude on the next Pi bump.
- **Build.** The `vite` Cloudflare config adds a `worker_loaders` binding when codemode is used (`packages/vite/src/cloudflare-worker-config.ts`).
- **Fallback.** If Dynamic Workers aren't available, run the QuickJS WASM (`quickjs-wasi`) inside a Flue-owned executor worker. It still can't reuse Pi's worker file.

## 6. Do pi-durable, chord, pi-mcp and pi-ai run under workerd? (0.99.2 tarballs, `node:` imports in dist)

- **pi-durable:** yes.
  - `node:` imports appear only in `env/node.js` and `storage/sqlite/node.js`. The root, `/storage/sqlite`, `/storage/memory`, `/storage/jsonl`, `/env`, `/tools`, and `/testing` are clean.
  - `/tools` imports only `typebox` and `diff`.
  - `sideEffects: false`.
- **chord:** yes for the root, `/context` and `/delta`. `node/*` (`vm`, `fs`, `module`) and `/bundler` (esbuild) must not be imported. esbuild is still a dependency; `allowBuilds: esbuild: false` is fine.
- **pi-mcp:** only with care.
  - The root re-exports `StdioTransport` (`transports/stdio.js`: `node:child_process`, `node:process`, `cross-spawn`). `/oauth` re-exports `OAuthCallbackServer` (`node:http`).
  - `sideEffects: false` lets the Vite build tree-shake `StdioTransport` when it isn't referenced.
  - Mitigation: import only `McpClient`, `StreamableHttpTransport` and `toLlmContent`. In the Cloudflare build, add `resolve.alias` stubs for `cross-spawn` and `node:child_process`. Add a bundle-content test asserting no `child_process` in the worker output.
- **pi-ai:** yes, same as today.
  - `node:` imports appear only in `auth/oauth/*` and `cli.js`, which the root doesn't reach.
  - Bedrock (`@aws-sdk/*`, `@smithy/node-http-handler`, proxy agents) sits behind the lazy `bedrock-converse-stream.lazy.js` dynamic import, the same pattern as 0.87.
- **pi-agent-core:** root is clean (`node:` only in `harness/env/nodejs`, `pico3`, `testing`). After the refactor it's needed only for skill helpers and types.
- **pi-codemode:** no (§5). The `/declarations` and `/source` subpaths are fine.
- **All packages declare `engines.node >= 22.19`.** That is advisory and doesn't affect workerd.

## 7. Ordered commits (each type-checks)

Build, type-check and test run in CI or a container because of the host build ban. Every step keeps `tsc --noEmit` green. New modules that aren't wired in yet get temporary `knip.json` `ignoreIssues`/entries, removed in step 8.

1. **Pin Pi 0.99.2 exactly.**
   - `packages/runtime/package.json`: `pi-ai` and `pi-agent-core` to `0.99.2`; add `@earendil-works/pi-durable`, `@earendil-works/chord`, `@earendil-works/pi-mcp`, `@earendil-works/pi-codemode` at `0.99.2`.
   - `packages/vite/package.json:50`, `apps/www/package.json:16`, `examples/{chat-sdk,react-chat,hello-world}/package.json`.
   - `pnpm-workspace.yaml`: `overrides: '@earendil-works/*': 0.99.2`; add the new names and `pi-telemetry` to `minimumReleaseAgeExclude`.
   - `pnpm-lock.yaml`.
   - Fix 0.87→0.99 signature drift in `session.ts`, `compaction.ts`, `conversation-reducer.ts`, `runtime/providers.ts`, `cloudflare/workers-ai-provider.ts`. Every imported symbol still exists by name in 0.99.2; that was checked against the d.ts files.
   - The legacy loop still runs.
2. **Opaque offsets.**
   - New `streams/offset.ts` (`StreamOffset`, `compareOffsets`).
   - Remove core `parseOffset` uses: `runtime/handle-conversation-routes.ts:207,285`, `conversation-fold-host.ts:72,134`, `runtime/conversation-observer.ts:65,183` (switch `batchOrdinal` to a store-supplied ordinal), `conversation-fold-checkpoint.ts:195,207`.
   - Keep `formatOffset`/`parseOffset` exported from `adapter.ts:141-143` for store implementations (redis/mongodb).
   - Update `test-utils/define-conversation-stream-store-contract-tests.ts` to drop integer assumptions.
3. **Log port.** `streams/log.ts`, `streams/memory-log.ts`, `streams/store-bridge-log.ts`, and `test-utils/define-durable-stream-log-contract-tests.ts` (producer, Stream-Seq and fencing cases). Not wired.
4. **Electric HTTP log and webhook verifier.** `streams/electric-log.ts`, `entity/webhook.ts`; tests against `InMemoryDurableStreamLog` semantics plus recorded Electric responses.
5. **StreamStorage.**
   - `pi/commit-envelope.ts`, `pi/fenced-sqlite-database.ts`, `pi/commit-outbox.ts`, `pi/stream-storage.ts`, `cloudflare/do-sqlite-database.ts` (`sql.exec` + `transactionSync`), `node/node-sqlite-database.ts`.
   - Tests: Pi `registerStorageConformance` over StreamStorage; a "one transaction per commit, callback returns Seq" guard test; crash-injection at the three points in §2.4; rebuild equivalence (snapshot every Pi read before and after rebuild).
6. **Flue Pi adapter skeleton.**
   - `pi/host.ts`, `pi/docs.ts`, `pi/receipts.ts`, `pi/registry-bridge.ts`, `pi/execution-env.ts`, `pi/tools.ts` (tool-adapter; Pi `/tools` for read/write/edit/bash; Flue grep/glob), `pi/config.ts` (compaction/model/thinking/retry mapping), `pi/hooks.ts` (use-agent-start/finish, response hooks, attachment rehydration).
   - Tests with the pi-ai faux provider. Not wired into the coordinators.
7. **Projection.**
   - `pi/projection.ts`, and `conversation-public.ts` functions switched to take either source.
   - Golden tests: the same scripted agent on the legacy loop vs `FluePiHost` must produce equal SDK snapshots and chunk sequences, modulo ids.
8. **Cut over the coordinators.**
   - `cloudflare/agent-coordinator.ts` (admitDispatch :1234 → `host.admit`; drain/supervisor :337-411 → `host.wake`; onAlarm :445), `cloudflare/flue-agent-class.ts` (`__flueWake`), `node/agent-coordinator.ts`, `runtime/agent-submissions.ts` (admission-only), `format-version.ts` (bump), `legacy/import.ts` (move reducer and records to `legacy/`; one import commit per conversation).
   - Remove the temporary knip ignores.
9. **Native MCP.** `mcp.ts` on `pi-mcp`; drop `@modelcontextprotocol/client` from `packages/runtime/package.json` (keep `@modelcontextprotocol/server` as a devDependency for tests); add Vite aliases for the stdio stubs in `packages/vite/src`.
10. **Skills.** `pi/skills.ts` (the `systemPrompt.section` + `activate_skill` ToolRegistration via `formatSkillsForSystemPrompt`/`formatSkillInvocation`); `agent.ts:425` becomes a thin wrapper.
11. **Subagents/tasks.** `pi/subagent-tool.ts` per `durable/test/examples/22-24`, wired to `hooks/use-subagent.ts` and `session.task()`. Delete `harness-tool-lineage.ts`.
12. **Code Mode.** `pi/codemode/{executor,tool}.ts`, `cloudflare/codemode-dynamic-worker.ts`, `node/codemode-node.ts`, a new additive public hook `hooks/use-code-mode.ts`, and the vite `worker_loaders` binding.
13. **A2A entities.**
   - `entity/{services,facet,tools-facet,relay,inbox,schedules,observations}.ts`, the webhook route in `runtime/flue-app.ts`, and exports from `index.ts`.
   - Chord `createFacetHost` inside `pi/host.ts`.
   - An e2e test: Alice sends to a sleeping Bob, Bob is evicted and redeployed, both histories are replayable.
14. **Delete the legacy cognition.**
    - `session.ts` down to the facade; delete `compaction.ts`, `conversation-writer.ts`, `conversation-reader.ts`, `submission-state.ts`, `runtime/settlement-rebuild.ts`, the Agent import, and `sql-agent-execution-store.ts` writes.
    - Mark `AgentSubmissionStore` deprecated; docs and changeset.
    - The `legacy/` import stays one release, then gets deleted.

## 8. Risks

1. **Coupling to SqliteStorage internals.** The outbox co-transaction relies on SqliteStorage@0.99.2 making exactly one `db.transaction()` per `commit()` whose callback returns the Seq. It's version-pinned and guarded by a test; on every Pi bump, re-check storage.ts (main already changed this file after 0.99.2).
2. **Replay determinism** depends on `next_seq` incrementing by one from 1 and on commits never being skipped. Mitigations: an envelope `seq` assertion during rebuild, and the `storage` incarnation id.
3. **Publish latency and availability.** Readers only see published commits. An Electric outage makes the public stream stale while Pi keeps working locally, and the outbox grows in DO SQLite. Add a size alarm and, optionally, backpressure (reject new admissions above N MB of pending envelopes).
4. **Envelope size.** Document bases, tool outputs and images can make large commits. Mitigations: attachment placeholders, `pi.commit.part` splitting within one POST, Pi's default output limits (50 KiB).
5. **Append rate.** 10/s per streaming conversation from partial flushes. Measure Electric cost; if it's too high, batch several outbox rows per POST (still one Stream-Seq per row isn't possible in one POST, so use the last seq). Leave that as a later optimization only if needed.
6. **Model-facing tool changes.** Replacing Flue's read/write/edit/bash with Pi's tools changes schemas and behavior. The authoring API is preserved, but evals may shift. Flag it in the changeset and consider keeping Flue's schemas behind a flag.
7. **Registry timing.** Dynamic resources (`SessionRerender`, session.ts:493/939) only take effect at Pi phase boundaries (`RegistrySnapshot` is refreshed per phase). A tool declared mid-turn becomes visible one phase later than today.
8. **Legacy data import** is lossy for Flue-only advisories (e.g. `tool_step_settled` lineage) and forces old SDK offsets through a `conversation-reset`.
9. **pi-mcp stdio in Worker bundles.** Tree-shaking has to remove `cross-spawn`; aliases are the backstop.
10. **Code Mode fidelity.** The Flue prelude may drift from Pi's; the conformance corpus is the guard. Worker Loader availability, pricing and limits on the target account need confirming.
11. **Pi Durable maturity.** It's new, `AgentEvent` is experimental, and Harness `subscribeCommits` has a TODO. Pinning exact versions plus Pi's own conformance suite reduces the risk.
12. **DO single-writer assumptions.** Electric `403` fencing turns split-brain into a hard stop, not silent divergence. Epoch bumps must happen only on rebuild.
13. **Electric producer-state TTL.** In-memory stores keep producer state for 7 days (PROTOCOL §5.2.1). After expiry the producer looks new, and `Stream-Seq` still prevents duplicates. Verify that the deployed server persists `last_seq_header`.
14. **Receipt two-commit admission** leaves a window that the wake-time `admitting` repair covers. Tests have to cover a crash between A and B.
15. **Delivery semantics of webhook wakes.** They are at-least-once with lease generations. Inbox admission is idempotent through `requestId`; cursors are advisory.

### Critical Files for Implementation
- /home/nymphai/nymphai/worktrees/p-nym-20/third_party/flue/packages/runtime/src/session.ts
- /home/nymphai/nymphai/worktrees/p-nym-20/third_party/flue/packages/runtime/src/cloudflare/agent-coordinator.ts
- /home/nymphai/nymphai/worktrees/p-nym-20/third_party/flue/packages/runtime/src/runtime/agent-submissions.ts
- /home/nymphai/nymphai/worktrees/p-nym-20/third_party/flue/packages/runtime/src/runtime/conversation-stream-store.ts
- /home/nymphai/nymphai/worktrees/p-nym-20/third_party/flue/packages/runtime/src/conversation-public.ts
- /tmp/research/pi/repo/packages/durable/src/types.ts and packages/durable/src/storage/sqlite/storage.ts (read at tag v0.99.2)