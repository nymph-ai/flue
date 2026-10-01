# Flue on Cloudflare: the native shape

This is the normative runtime architecture for Flue agents on Cloudflare
(nymph-ai/nymphai #3749, #3751, #3752). Where code and this document disagree,
fix one of them in the same change.

```
Internet / clients ──► Gateway Worker ── auth, routing, wake doorbell, OAuth callbacks
                              │ DO RPC
                              ▼
                 AgentDO(entity id)     one SQLite-backed Durable Object per entity
                   ├─ Pi Durable Harness  (cognition, tasks, compaction, recovery)
                   ├─ Pi SqliteStorage    (on ctx.storage.sql via Flue's adapter)
                   ├─ Flue tables         (stream cursors, wake high-water, dedupe)
                   ├─ MCP client          (@modelcontextprotocol/client, stateless 2026-07-28)
                   └─ Code Mode           (@cloudflare/codemode) ──load()──► Dynamic Worker
                              │                                    globalOutbound: null
                              ▼                                    HOST RPC only
                   Electric Durable Streams: entity inboxes, events, world streams
```

## Roles

| Piece | Owns | Does not own |
| --- | --- | --- |
| Gateway Worker | routing, auth, webhook verification, OAuth redirects | state |
| AgentDO | identity, serialization, local durable state, supervision | a permanently running process |
| Pi Durable | cognition: sessions, tasks, tool recovery, compaction | transport, Electric, Cloudflare |
| DO SQLite | Pi's state and Flue's cursors; the agent's record | the public coordination history |
| Electric | entity events: inbox messages, published events, world observations | Pi's internal commits |
| Dynamic Worker | one Code Mode execution, no ambient network | anything persistent |
| Fabric (later, #3754) | semantic admission of governed effects | agent cognition |

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
   `AgentDO.wake(stream, head)`, which durably records the high-water offset,
   calls `setAlarm(now)` and returns. The webhook is acked once that record is
   durable, not after processing.
4. **Alarms are the pump.** The alarm drains each stream from its committed
   cursor toward the recorded head in bounded chunks: admit each event as an
   idempotent Pi submission keyed by its event id, advance the cursor, and
   re-arm while work remains. Pi Durable resumes interrupted turns on later
   wakes; a turn is never required to fit in one alarm.
5. **Effects are idempotent, not co-committed.** A send or publish appends one
   event with a deterministic id derived from the Pi task and tool call. Pi's
   tool replay re-sends the same id; receivers deduplicate on it. There is no
   outbox around Pi's commit.
6. **MCP is stateless and remote, only.** Streamable HTTP with the
   2026-07-28 protocol (no sessions, no initialize handshake,
   `server/discover`). Servers on earlier revisions and stdio servers are not
   supported, on any target. OAuth tokens live in a Durable Object keyed by
   principal and authorization server; redirects land on the Gateway.
7. **Code Mode runs in Dynamic Workers.** `@cloudflare/codemode` in the
   AgentDO, registered with Pi Durable as one tool, with its own runtime as a
   Cloudflare Durable Object Facet of the AgentDO (search, describe, snippets,
   steps, approvals). Generated code reaches the world only through the tools
   and connectors the AgentDO hands it.
9. **Questions to people are entity events.** MCP `input_required` results
   (elicitation) and Code Mode approvals publish an `input-requested` event on
   Electric and park the call durably; the answer arrives in the agent's inbox,
   rings the doorbell, and the call is retried with the answers and the
   server's `requestState`. Humans are participants on streams like agents.
8. **No always-on connections from an AgentDO.** Nothing that defeats
   hibernation: no outbound WebSockets, no long-lived MCP listen streams.
   Freshness comes from wakes and cacheable list results.

## Not part of the design

Containers, Queues, Workflows, PGlite, Node runtimes on Cloudflare, Electric as a
replica of Pi's log, stdio MCP, and pre-2026-07-28 MCP servers. (Cloudflare's
"Durable Object Facets" are used only as Code Mode's runtime; the name is
unrelated to Chord facets.)
