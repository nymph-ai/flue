# Flue on Cloudflare: the native shape

This is the normative runtime architecture for Flue agents on Cloudflare
(nymph-ai/nymphai #3749, #3751, #3752). Where code and this document disagree,
fix one of them in the same change.

```
Internet / clients ──► Gateway Worker ── auth, routing, wake doorbell, OAuth callbacks
                              │ DO RPC
                              ▼
                 AgentDO(entity id)     one SQLite-backed Durable Object per entity
                   ├─ Lifecycle           (agents/lifecycle: name, startup, capability dispatch)
                   ├─ Pi Durable Harness  (cognition, tasks, compaction, recovery)
                   ├─ Pi SqliteStorage    (on ctx.storage.sql via Flue's adapter)
                   ├─ Flue tables         (stream cursors, wake high-water, conversation cache)
                   ├─ MCP client          (@modelcontextprotocol/client, 2026-07-28 or 2025)
                   └─ Code Mode           (@earendil-works/pi-codemode: QuickJS in-process,
                              │                    tools.* and models.* only)
                              ▼
                   Electric Durable Streams: entity inboxes, events, world streams
```

## Roles

| Piece                       | Owns                                                                | Does not own                    |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------- |
| Gateway Worker              | routing, auth, webhook verification, OAuth redirects                | state                           |
| AgentDO                     | identity, serialization, local durable state, supervision           | a permanently running process   |
| Pi Durable                  | cognition: sessions, tasks, tool recovery, compaction               | transport, Electric, Cloudflare |
| DO SQLite                   | Pi's state and Flue's cursors; the agent's record                   | the public coordination history |
| Electric                    | entity events: inbox messages, published events, world observations | Pi's internal commits           |
| QuickJS VM (in the AgentDO) | one Code Mode execution, no ambient network                         | anything persistent             |
| Fabric (later, #3754)       | semantic admission of governed effects                              | agent cognition                 |

An entity's identity is its Durable Object id, its Electric stream addresses and
its Pi state. Objects in memory are a projection rebuilt on every wake; eviction
is uninteresting by design.

## Rules

1. **Pi is unmodified and unvendored.** Pi Durable runs on its public `Storage`
   with Pi's own `SqliteStorage`; Flue supplies only the documented
   `SqliteDatabase` adapter for `ctx.storage.sql`. No Pi source is copied into
   Flue. No fork.
2. **Pi's commits never leave the Durable Object.** Electric carries entity
   events only. The public conversation wire for `@flue/sdk` is a projection
   over Pi storage, cached in the DO.
3. **Wakes are doorbells.** A verified Electric webhook calls
   `AgentDO.wake(stream, head)`, which durably records the high-water offset
   and, when that leaves the stream behind, calls `setAlarm(now)` — in one
   synchronous turn, one atomic write — and returns. A duplicate or stale
   doorbell writes nothing. The webhook is acked once that record is
   durable, not after processing.
4. **Alarms are the pump.** The alarm drains each stream from its committed
   cursor toward the recorded head in bounded chunks: admit each event as an
   idempotent Pi submission keyed by its event id, advance the cursor, and
   re-arm while work remains. Pi Durable resumes interrupted turns on later
   wakes; a turn is never required to fit in one alarm. Every wake is a full
   wake that re-derives every later deadline from durable state, so the
   alarm time itself is the only wake record: an arm moves it earlier or
   writes nothing. The AgentDO is a plain `DurableObject` composed with the
   Agents SDK's `Lifecycle` for addressing, startup and capability dispatch —
   not `Agent`, which installs state, WebSockets, schedules, queue, tasks,
   MCP and dynamic agents and migrates their tables on every new object.
   Flue does not use Lifecycle's job queue: it costs several rows written per
   wake, and it owns the physical alarm outright.
5. **Effects are idempotent, not co-committed.** A send or publish appends one
   event with a deterministic id derived from the Pi task and tool call. Pi's
   tool replay re-sends the same id; receivers deduplicate on it — an inbox
   event becomes the Pi submission keyed by it, an observed published event
   the Pi write keyed by it. There is no outbox around Pi's commit.
6. **MCP is remote, and holds nothing open.** Streamable HTTP, probing
   with `server/discover` for the stateless 2026-07-28 protocol and falling
   back to the standard 2025 `initialize` handshake for servers that do not
   speak it (most do not yet, Linear's among them). The negotiated revision
   and a 2025 session id live in memory only — a cold start negotiates again
   and writes no rows — and no server-to-client stream is opened. stdio
   servers are not supported, on any target. OAuth tokens live in a Durable
   Object keyed by principal and authorization server; redirects land on the
   Gateway.
7. **Code Mode runs in the AgentDO.** Pi's Code Mode
   (`@earendil-works/pi-codemode`), registered with Pi Durable as one tool,
   runs each script in a fresh QuickJS VM inside the AgentDO's own isolate,
   with the QuickJS module imported at build time (workerd compiles no wasm at
   run time). Scripts see Pi's surface exactly — `tools.*` (the agent's tools,
   MCP tools as `mcp__<server>__<tool>`), `models.*` (catalog and
   classifiers), `text`/`image`/`exit`, `store`/`load` — and reach the world
   only through it. The VM is bounded by a heap limit and an interrupt-poll
   CPU budget inside the object's 30 s CPU limit. Nothing is persisted per
   script: `store()` writes go to a conversation document, and only a script
   that asks a question (rule 8) journals its nested calls' results, so a
   rerun after an eviction answers them from the journal and runs the parked
   call once. The cost model is the reason: a Dynamic Worker is billed per
   unique (id, code) pair a day and model-written code is unique every time,
   while QuickJS's CPU runs while the object is already awake on the model
   and its tools.
8. **Questions to people are entity events.** MCP `input_required` results
   (elicitation) and Code Mode approvals publish an `input-requested` event on
   Electric and park the call durably; the answer arrives in the agent's inbox,
   rings the doorbell, and the call is retried with the answers and the
   server's `requestState`. Humans are participants on streams like agents.
   The call parks inside Pi Durable — a `flue.question` task owned by the
   asking tool task, with the turn left open and no model round trip — and
   Pi's rerun of the tool call continues it after an eviction
   (`packages/runtime/src/pi/questions.ts`). The `input-requested` event goes
   to `flue/v1/{type}/{id}/questions` (and to a configured responder's
   inbox); the answer is an `input-answered` inbox event.
9. **No always-on connections from an AgentDO.** Nothing that defeats
   hibernation: no outbound WebSockets, no long-lived MCP listen streams.
   Freshness comes from wakes and cacheable list results.

## Not part of the design

Containers, Queues, Workflows, PGlite, Node runtimes on Cloudflare, Electric as a
replica of Pi's log, stdio MCP, standing MCP streams, and Dynamic Workers
or Durable Object Facets for Code Mode (rule 7).
