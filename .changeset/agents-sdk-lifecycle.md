---
'@flue/runtime': minor
'@flue/vite': minor
---

Cloudflare Agents SDK 0.24. A generated agent Durable Object is now a plain `DurableObject` composed with the SDK's `Lifecycle` (`agents/lifecycle`), not a subclass of `Agent`.

- `Agent` installs state, WebSockets, schedules, a queue, tasks, MCP and dynamic agents on every object, and migrates their tables on every new one; Flue used none of them. Without it, the Agents SDK reads and writes no row on a Flue agent: a new entity's first wake drops from 713 read / 277 written to 285 / 223, and every measured scenario costs less than before (hermetic workerd counters, `setAlarm` billed as a row).
- Lifecycle supplies named addressing (`ctx.id.name`), startup and capability dispatch. Flue keeps the alarm: Lifecycle's job queue costs a job row, a running mark, a completion and two `setAlarm`s per wake, and owns the physical alarm outright. The alarm time is now the only wake record: every wake is a full wake that re-derives later deadlines, an arm moves the alarm earlier or writes nothing, and the arms a wake makes fold into one `setAlarm` at its end. An idle wake writes nothing.
- The `__flueWake` doorbell records the high-water mark and, only when that leaves the stream behind and no earlier alarm is armed, calls `setAlarm(now)`, in one synchronous turn. A duplicate or stale doorbell writes nothing.
- Addressing is native: the generated entry reaches an object with `namespace.getByName(id)`; there is no warm-up RPC before each request (`getAgentByName`'s `__unsafe_ensureInitialized`). The object's fetch, alarm and doorbell start its Lifecycle.
- Removed: the pre-Pi fiber recovery shim (`onFiberRecovered`), the `__flueWakeAgentSubmissions` schedule target and the Agents SDK `schedule()` rows behind every wake, the eager wake on every cold start (Pi's live-task backstop is the durable alarm and survives eviction and redeploys), and the internal `createFlueAgentClass` `AgentBase` option (now `DurableObject` and `Lifecycle`).
- **Breaking for `extend({ base })`:** `base` receives the `DurableObject` with `this.lifecycle`, not `Agent`. `this.schedule()`, `this.setState()` and `this.queue()` are gone. Capabilities that do not use the alarm (`State`, `WebSockets`) install with `this.lifecycle.use(...)` in the subclass constructor; those that ride the job queue (`Scheduler`, `Queue`, `Tasks`) are not supported. `CloudflareAgentLike` now describes that shape. `__flueWake()` joins `fetch()`, `alarm()` and `onRequest()` as Flue-owned methods.
