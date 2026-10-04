# Flue on Cloudflare: the native shape

This is the normative runtime architecture for Flue agents on Cloudflare
(nymph-ai/nymphai #3749, #3751, #3752). Where code and this document disagree,
fix one of them in the same change.

```
                         Internet / MCP clients
                                  │
                                  ▼
                           Gateway Worker
                    auth / routing / protocol
                      /                    \
                     /                      \
                    ▼                        ▼
          MCP transport plane             AgentDO(entity id)
      cards / HTTP / listen streams    identity + Pi Durable
           /          \                 private SQLite state
          /            \                      │
         ▼              ▼                     │
 Subscription DO     Electric ◄───────────────┘
 (only if needed)       ▲                entity events
                         │
                    world streams
```

## Roles

| Piece                                     | Owns                                                                          | Does not own                    |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| Gateway Worker                            | routing, auth, webhook verification, OAuth redirects                          | state                           |
| AgentDO                                   | identity, serialization, local durable state, supervision                     | a permanently running process   |
| MCP Transport Plane (McpListenDO / SubDO) | cards, HTTP/SSE transport, long-lived listen streams, subscriptions & retries | agent cognition, event truth    |
| Pi Durable                                | cognition: sessions, tasks, tool recovery, compaction                         | transport, Electric, Cloudflare |
| DO SQLite                                 | Pi's state and Flue's cursors; the agent's record                             | the public coordination history |
| Electric                                  | entity events: inbox messages, published events, world observations           | Pi's internal commits           |
| QuickJS VM (in the AgentDO)               | one Code Mode execution, no ambient network                                   | anything persistent             |
| Fabric (later, #3754)                     | semantic admission of governed effects                                        | agent cognition                 |

An entity's identity is its Durable Object id, its Electric stream addresses and
its Pi state. Objects in memory are a projection rebuilt on every wake; eviction
is uninteresting by design.

## The Cloudflare Invariants

The fundamental rule governing MCP transport and agent runtime integration is:

> **No MCP transport requirement is allowed to change the AgentDO lifecycle.**

1. **AgentDO never holds `subscriptions/listen`.** An SSE or long-lived listener inherently wants to remain connected; AgentDOs hibernate between discrete events.
2. **AgentDO never stores MCP webhook subscriptions or delivery logs.** Subscriptions, callback URLs, Standard Webhooks signing keys, and delivery attempts belong strictly in the MCP transport/subscription service plane.
3. **AgentDO never stores a duplicate Electric event history.** Electric's `DurableStreamLog` is the sole authoritative log of events; AgentDO only stores its consumption cursors.
4. **MCP server never stores a duplicate Pi task journal.** Tasks are executed either via AgentDO (Pi Durable) or bounded service DOs; the MCP projection layer never acts as a shadow execution engine.
5. **MCP transport objects may remain connected; agent objects must remain hibernatable.** Transport objects exist to serve connections; agent objects wake, do bounded work, persist, and disappear.
6. **All external ingress terminates at Gateway Worker or a purpose-built transport DO.** Incoming requests are authenticated and normalized before reaching agents or projections.
7. **MCP → agent execution crosses an explicit DO RPC/service boundary.** The MCP projection consumes `OperationPort`, which invokes `AgentOperationService` on an AgentDO via DO RPC, mapping cleanly onto Pi Durable public abstractions.
8. **Electric wakeups are high-water doorbells everywhere, including MCP event delivery.** Webhook delivery does not write-couple to event generation; Electric advances, wakes the subscription plane via doorbell, which reads Electric from its durable cursor.
9. **No cross-DO transaction is required for semantic correctness.** Systems coordinate asynchronously through Electric streams and idempotent operations.
10. **Evicting every in-memory object at any boundary must preserve correctness.** All durable state lives in SQLite or Electric; any DO isolate can terminate at turn boundary without data loss.

## Electric: Semantic Event Fabric, Not Replication

Electric is explicitly an interaction and collaboration fabric, **not an execution or replication log**.

> **Electric carries externally meaningful semantic events, not Pi Durable state changes. Pi's execution history remains private to the agent's durable runtime.**

```text
Pi Durable / AgentDO
   │
   │ private state transitions
   │ tool replay
   │ model turns
   │ compaction
   │ task internals
   │ registry changes
   ▼
DO SQLite
   │
   │ only meaningful externally observable events
   ▼
Electric
```

### The Invariant Test

> **Would another entity behave differently because this happened?**

If no, the state change stays in Pi's local DO SQLite.

### What Stays Local in DO SQLite

The following never hit Electric by default:

- Model tokens and streaming deltas
- Pi task scheduler transitions
- Internal retries and recovery attempts
- Tool-call journal entries
- Compaction operations
- Conversation document writes
- Registry mutations and `setActiveTools`
- Intermediate reasoning and execution state
- MCP tool discovery and inspection
- Cache changes
- Admission bookkeeping
- Internal task status fluctuations (e.g. `queued -> running -> retrying -> running`)

### What Goes to Electric

Electric carries domain events where another consumer (an agent, human participant, or external MCP subscriber) needs to react:

- `agent.message.sent`, `agent.message.received`
- `observation.received`
- `question.requested`, `question.answered`
- `task.delegated`, `task.completed`, `task.failed`, `task.cancelled`
- `artifact.published`
- `effect.proposed`, `effect.completed`, `effect.failed`
- `schedule.fired`
- `agent.status.changed` (only externally meaningful transitions, e.g. `agent.available`)
- `mcp.task.completed` (where an external MCP subscriber explicitly requested it)

### Projections, Not Commits

Electric receives semantic projections across Flue event projectors, never raw Pi transaction commits:

- **Aggressive Coalescing**: Micro-states within a single turn are coalesced. If status changes multiple times during a turn (`busy`, `thinking`, `using_tool`), only the terminal meaningful transition (`available`) is published. Batch observations are projected as consolidated events (`observation.batch.processed`).
- **Reference-Only Payloads**: Large payloads (artifacts, code bundles, document bodies) are referenced by opaque URI (`artifact://art_123/7`), never dumped into the stream as multi-megabyte payloads. Electric costs scale with collaboration, not compute.
- **MCP Event Subscriptions**: MCP subscriptions (such as ChatGPT webhooks for `task_changed`) subscribe to this semantic projection, filtering out routine progress noise: `queued/running` produce no external webhook events; only actionable or terminal states (`input_required`, `completed`, `failed`, `cancelled`) trigger webhook deliveries.
- **Fabric V4 Role**: Fabric stays out of the critical path and synchronous admission loop. When its semantics settle, Fabric attaches cleanly as an asynchronous consumer/producer over Electric semantic events without modifying AgentDO, Pi, or the MCP projection plane.

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
