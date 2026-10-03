# Flue MCP Capability Projection Architecture

**Status:** implementation plan  
**Owner:** Flue server/runtime  
**Tracking:** Fabric Agent Society Runtime — Flue / Pi / Electric (`P-NYM-20`, `NYM-1459`, GitHub `nymph-ai/nymphai#3749`)  
**Protocol floor:** MCP `2026-07-28`

## 1. Goal

Make Flue a capability-negotiated MCP server that can expose modern MCP extensions and experimental proposals when a client understands them, while preserving a complete, useful MCP `2026-07-28` core surface when it does not.

The architecture must not fork Flue semantics by client. There is one canonical internal capability model and multiple protocol projections over it.

MCP extensions improve discovery, presentation, scheduling, delivery, identity, and metadata. They do not become the source of truth for Flue runtime semantics.

## 2. Architectural rule

```text
                        upstream systems
                   Linear / GitHub / RSS / Fabric
                              │
                              ▼
                         Electric streams
                              │
                              ▼
                    ┌─────────────────────┐
                    │        FLUE         │
                    │                     │
                    │ Capability Registry │
                    │ Semantic Metadata   │
                    │ Search Index        │
                    │ Policy / Effects    │
                    │ Durable Handles     │
                    └──────────┬──────────┘
                               │
                    Projection / Negotiation
                               │
       ┌───────────────────────┼────────────────────────┐
       │                       │                        │
       ▼                       ▼                        ▼
 MCP 2026-07-28          official extensions     experimental extensions
 core projection          Skills / Tasks / UI     Events / Variants / ...
```

The capability registry is canonical. Skills, Apps, Events, Tasks, Variants, progressive discovery, trust metadata, action metadata, and future extensions are projections over the same objects.

## 3. Canonical capability model

Flue should normalize all exposed functionality into a registry entry with stable identity and enough metadata to project into any supported protocol.

```text
Capability
  id                    stable Flue identity
  kind                  tool | resource | skill | workflow | event | app
  title
  description
  inputSchema
  outputSchema
  invoke
  resources[]
  skills[]
  ui?
  asyncPolicy
  eventSources[]
  searchMetadata
  trust
  effects
  authorization
  variants
```

Related internal objects:

```text
CapabilityRegistry
SearchIndex
ProjectionProfile
RequestCapabilityResolver
ProtocolProjection
OperationStore
EventProjection
PolicyInterceptorPipeline
AuthContext
```

No MCP extension owns durable state. The registry, OperationStore, Electric streams, and Flue policy state remain authoritative.

## 4. Negotiation model

MCP `2026-07-28` is the compatibility floor.

Capability negotiation is request-scoped. Flue should resolve behavior from:

```text
resolve(
  protocolVersion,
  requestClientCapabilities,
  authenticatedPrincipal,
  explicitProjectionProfile?
)
```

Do not infer protocol behavior from `clientInfo.name` or another client fingerprint. Client identity is descriptive, not a hidden feature flag.

`server/discover` advertises the core and extension surface. Extension methods are only used when the requesting client advertises or explicitly invokes them.

## 5. Compatibility matrix

| Feature | Preferred/native path | MCP 2026-07-28 fallback | Graceful loss |
|---|---|---|---|
| Skills | Skills extension (`skills/list`, `skills/get`, directory reads) | Resources and resource templates | Skill-aware discovery and manifest semantics |
| Progressive discovery | Future standardized discovery protocol | Stable `flue.search` → `flue.describe` → `flue.invoke` tools plus resources | Native tools are not promoted into the host catalog |
| Apps | MCP Apps / `ui://` resources | Ordinary tools, structured/text results, resource links | Interactive UI |
| Tasks | Tasks extension | Durable `job://` resource plus job tools | Native task result type and task UX |
| Events | MCP Events webhook subscription | Event-stream resources plus `subscriptions/listen` while connected | Offline server→client wake |
| Server Cards | Server Card endpoint | `server/discover` after connection | Pre-connection discovery |
| Variants | SEP-2053-style negotiated variant | Stable default projection profile | Client-selected catalog/description optimization |
| Interceptors | Internal Flue interceptor pipeline; expose standard form later | Same internal pipeline | Nothing |
| Trust annotations | Standard/draft trust annotation vocabulary | Namespaced `_meta` plus ordinary content metadata | Generic client cannot interpret trust semantics automatically |
| Action metadata | Standard/draft action metadata | Tool schemas/descriptions plus server-side enforcement | Client cannot reason generically about effects |
| Tool resolution | `tools/resolve` if standardized | `flue.resolve` + MRTR/elicitation when approval is required | Generic native preflight UX |
| Agent identity/delegation | Future standard delegation/auth extensions | Normal OAuth principal and explicit Flue delegation handles | Portable delegated-agent identity |

The only fundamental semantic gap is offline wake. A disconnected core-only MCP client cannot be awakened. Everything else has a useful core representation or disappears without breaking ordinary MCP behavior.

## 6. Skills → MCP Resources

Skills should be stored as Resources first and projected as Skills second.

Canonical resource examples:

```text
skill://git-workflow/SKILL.md
skill://git-workflow/references/branches.md
skill://git-workflow/scripts/check.sh
```

### Skills-aware client

```text
skills/list
    ↓
skills/get
    ↓
resources/read
```

### Core-only client

```text
resources/list
    ↓
resources/read(skill://.../SKILL.md)
```

Expose skill trees through resource templates such as:

```text
skill://{skill}/{path}
```

Do not automatically map a Skill to an MCP Prompt. A Skill and a Prompt are different semantic objects. A skill may additionally expose a Prompt only when it has an explicitly user-invocable workflow entry point.

Use core resource update notifications when skill resources change.

## 7. Progressive discovery → stable core meta-tools

Progressive discovery should be core-first rather than waiting on an unstable extension.

Expose a small permanent bootstrap surface:

```text
flue.search
flue.describe
flue.invoke
flue.categories        optional
```

`flue.search` accepts semantic query and kind constraints:

```json
{
  "query": "linear issue planning",
  "kinds": ["tool", "skill"]
}
```

and returns lightweight capability handles:

```text
linear.issue.create
linear.issue.update
linear.project.create
skill://linear/project-planning/SKILL.md
```

`flue.describe(capability)` returns the full description, JSON schema, output schema, relevant skills/resources, effects metadata, and authorization constraints.

`flue.invoke(capability, arguments)` executes the canonical capability.

Optionally expose descriptor resources:

```text
capability://linear.issue.create
capability://linear.project.create
category://linear
```

Search results can return normal MCP Resource Links to those descriptors.

### Important constraint: do not mutate `tools/list` as a search side effect

Do not implement:

```text
search("linear")
    ↓
mutate active tools
    ↓
tools/list changes because search was called
```

The core fallback remains a stable bootstrap tool list plus explicit handles. A future standardized progressive-discovery extension may promote native tool definitions from the same registry without changing Flue's architecture.

The bootstrap list must be deterministic and cacheable.

## 8. Apps → additive UI

MCP Apps are an optional presentation projection.

Native path:

```text
tool metadata → ui://linear/project-view
resources/read(ui://linear/project-view)
       ↓
host renders MCP App
```

Core fallback:

```text
tools/call
       ↓
structuredContent
text content
resource links
```

Every App-backed tool must be semantically complete without rendering the UI.

Never return only a UI pointer for information required to understand the operation result.

## 9. Tasks → durable Operation + Resource fallback

Implement a single internal asynchronous operation abstraction:

```text
Operation
  operationId
  state
  result
  inputRequests
  createdAt
  updatedAt
  cancellation
```

### Tasks-aware projection

Project the Operation through the Tasks extension:

```text
tools/call → task
tasks/get
tasks/update
tasks/cancel
```

### Core fallback

Return a normal completed MCP result containing a durable handle:

```text
structuredContent:
  state: running
  jobId: abc123

resource link:
  job://abc123
```

`resources/read(job://abc123)` returns operation state and final output.

A connected client can subscribe to `job://abc123` via core resource subscriptions and reread it on update.

Expose cancellation/input as ordinary tools:

```text
flue.job.cancel(jobId)
flue.job.respond(jobId, input)
```

MRTR/elicitation is for an in-progress request that needs immediate input. Do not use MRTR as a substitute for durable long-running jobs.

## 10. Events → Electric-backed projection

Electric remains the durable event/world stream. MCP Events is a delivery adapter, not the log.

### Native MCP Events

```text
events/list
events/subscribe
events/unsubscribe
        ↓
signed webhook
        ↓
host wake
```

The webhook payload should be small. It should identify the durable stream/event/cursor and let the agent read canonical state through Flue.

### Core fallback

Expose ordinary event-stream resources.

```text
flue.events.open(name, filters)
    ↓
streamId
eventstream://abc/head
cursor = C123
```

Read events with:

```text
resources/read(eventstream://abc/after/C123)
```

returning:

```text
events [...]
nextCursor = C131
```

The stable `eventstream://abc/head` resource changes whenever Electric advances.

A connected core client may:

```text
subscriptions/listen(eventstream://abc/head)
       ↓
notifications/resources/updated
       ↓
resources/read(eventstream://abc/after/C123)
```

The notification is a wake hint only. The authoritative semantics are always the durable Electric stream and saved opaque cursor.

### Hard degradation boundary

Core-only disconnected clients cannot be awakened. They resume by reading from their saved cursor on the next interaction.

Do not emulate offline wake with polling hidden inside the MCP server.

## 11. Server Cards → pre-connect form of server/discover

Generate both the proposed Server Card and `server/discover` from the same canonical server descriptor.

```text
Server Card  = pre-connection discovery
server/discover = post-connection discovery
```

A client that ignores Server Cards loses only pre-connect discovery.

## 12. Variants → projection profiles

Variants should map to an internal `ProjectionProfile`, not alter the canonical registry.

Example profiles:

```text
default
compact
research
coding
chatgpt
pi
```

A profile may control:

- descriptions;
- ranking;
- bootstrap tool set;
- preferred skills;
- resource visibility;
- verbosity.

If the client negotiates Variants, map the selected variant to a profile.

If it does not, use `default`.

Do not infer a profile from client name. Explicit deployment endpoints such as `/mcp/compact` may be supported as operator configuration when useful, but they are configuration, not client fingerprinting.

## 13. Interceptors → internal middleware first

Implement one internal policy/middleware pipeline through which every protocol projection passes:

```text
incoming request
      ↓
authentication
      ↓
capability resolution
      ↓
authorization
      ↓
effect / policy analysis
      ↓
audit / tracing
      ↓
invoke
      ↓
trust/result decoration
      ↓
response
```

Apply it to:

```text
tools/call
resources/read
skills/get
events/subscribe
tasks/get
flue.invoke
```

If MCP Interceptors stabilizes, adapt the internal middleware model to it. Do not implement Flue's core middleware semantics in terms of an experimental protocol.

## 14. Trust and action metadata

Maintain richer canonical metadata than the current wire protocols require.

```text
Trust
  source
  provenance
  sensitivity
  untrusted
  evidence

Effects
  read
  write
  destructive
  reversible
  idempotent
  externalCommunication
  moneyMovement
  userReviewRequired
```

When a client understands the standardized/draft trust/action annotations, project them directly.

For core clients:

1. place compatible advisory data in namespaced `_meta`;
2. include important user/model-facing facts in ordinary tool descriptions/results where appropriate;
3. enforce policy in the Flue interceptor pipeline regardless of whether the client understands metadata.

A client ignoring `requiresReview` must never bypass review. Wire annotations are advisory interoperability surfaces, not the enforcement boundary.

## 15. Tool resolution → advisory resolve + MRTR enforcement

Separate advisory resolution from mandatory approval.

### Advisory preflight

Expose ordinary core tool:

```text
flue.resolve(capability, arguments)
```

returning normalized arguments, expected effects, permissions, cost/limits, and required approvals.

If a future `tools/resolve` becomes standard, project the same internal resolver through it.

### Required approval/input

If actual execution requires confirmation or additional data:

```text
tools/call
    ↓
Flue policy requires input
    ↓
MRTR / input_required
    ↓
elicitation
    ↓
request retried with required input
    ↓
execute
```

The policy state and effect analysis live in Flue, not in the draft method.

## 16. Identity and delegation

Normal MCP authorization is the compatibility floor.

Core-only path:

```text
OAuth principal
      ↓
Flue authorization
      ↓
capabilities
```

Internal auth context should already support future delegation:

```text
AuthContext
  principal
  actor
  delegator
  scopes
  constraints
  proof
```

With no delegation metadata:

```text
actor = principal
```

When standard delegated-agent identity arrives, project it into the same context.

For Flue/Pi-specific use before standardization, explicit server-minted delegation handles may be created by a normal core tool and supplied to later invocations. Do not pretend such handles are portable MCP identity.

## 17. Implementation phases

### Phase 1 — MCP 2026-07-28 substrate

Complete and test:

- `server/discover`;
- tools list/call;
- resources list/read/templates;
- prompts;
- `subscriptions/listen` and resource-specific updates;
- MRTR / elicitation;
- deterministic list ordering and cache metadata;
- OAuth/auth context;
- namespaced `_meta` support.

### Phase 2 — canonical registry and projection engine

Implement:

- `CapabilityRegistry`;
- `SearchIndex`;
- `ProjectionProfile`;
- request-scoped capability negotiation;
- `ProtocolProjection` interface;
- capability/resource stable IDs.

No extension implementation proceeds around this layer.

### Phase 3 — progressive discovery

Implement:

- `flue.search`;
- `flue.describe`;
- `flue.invoke`;
- optional `flue.categories`;
- `capability://` resources;
- search/ranking over canonical capability metadata.

Move large capability catalogs behind this bootstrap surface while preserving explicitly pinned/universal tools.

### Phase 4 — Skills and Apps

Skills:

- canonical `skill://` resource storage;
- Skills extension projection;
- core Resource fallback.

Apps:

- `ui://` resources;
- UI metadata projection;
- enforce semantically complete non-UI tool results.

### Phase 5 — Tasks

Implement one durable `OperationStore` and both projections:

- Tasks extension;
- `job://` resource fallback plus job tools.

### Phase 6 — Events

Implement one `EventProjection` over Electric:

- MCP Events webhook delivery;
- durable subscription storage;
- signed delivery;
- core `eventstream://` Resources;
- opaque cursor reads;
- resource head/update subscriptions.

### Phase 7 — Server Cards and Variants

Generate Server Cards from the server descriptor.

Map Variants to `ProjectionProfile`.

Both should be thin adapters once Phases 1–3 exist.

### Phase 8 — semantic policy features

Land:

- common interceptor pipeline;
- trust model;
- effects model;
- `flue.resolve`;
- MRTR approval/input flow;
- delegation-aware auth context.

Expose draft/standard annotations, resolution, and identity protocols only as projections over these semantics.

## 18. Compatibility/conformance harness

CI must run the same semantic scenarios against capability matrices rather than testing each extension in isolation.

```text
Client A: MCP 2026-07-28 only
Client B: 07-28 + Skills
Client C: 07-28 + Tasks
Client D: 07-28 + Apps
Client E: 07-28 + Events/webhook
Client F: 07-28 + Variants
Client G: all supported extensions
```

Example scenario: "use the deployment skill and launch a build".

Expected protocol paths:

```text
A:
  resources/read(skill://...)
  flue.invoke(...)
  job://...

B:
  skills/get(...)
  flue.invoke(...)
  job://...

C:
  resources/read(skill://...)
  flue.invoke(...)
  native Task

G:
  skills/get(...)
  progressive/native discovery projection
  native Task
  native Event completion
  optional App result
```

All paths must resolve to equivalent canonical capability invocations and durable Flue records.

### Required invariants

The harness must prove:

1. Flue does not remember unsupported client extension capabilities across requests.
2. Search does not mutate `tools/list` as a side effect.
3. Extension metadata disappears cleanly for core clients.
4. Every App-backed tool is useful without rendering.
5. Every Skill remains readable as a Resource.
6. Every async Operation remains observable without Tasks.
7. Every durable event remains replayable without Events.
8. A client ignoring action/trust metadata cannot bypass server policy.
9. Duplicated or reordered event wakeups are harmless because Electric's durable cursor is authoritative.
10. A protocol projection cannot create semantics that are absent from the canonical registry/state.

## 19. Relationship to Flue / Pi / Electric architecture

This extends the existing P-NYM-20 ownership boundaries rather than changing them.

- **Flue** remains the sole integration seam and owns MCP projection, discovery, policy integration, transport adapters, and Cloudflare deployment/runtime adapters.
- **Pi Core / Chord / Pi Durable** remain cognition/durable execution primitives and do not gain Electric- or ChatGPT-specific semantics.
- **Electric Streams** remain the durable social/world event substrate. MCP Events is a delivery projection, not a replacement log.
- **Fabric** remains semantic admission/coordination authority for governed effects and knowledge/process closure.
- **ChatGPT, Pi, Claude, Cursor, and other MCP hosts** are clients with differing protocol capabilities; Flue does not fork its world model for them.

## 20. Non-goals

- Do not fork Pi to implement MCP extension semantics.
- Do not make draft MCP protocols canonical runtime interfaces.
- Do not infer client capabilities from product name.
- Do not use MCP notifications as the authoritative event log.
- Do not make UI required for semantic correctness.
- Do not maintain separate task/event/skill state for extension-aware versus core clients.
- Do not hide policy enforcement exclusively in client-understood annotations.
- Do not fake offline wake for core MCP clients.

## 21. Definition of done

The architecture is complete when:

1. Flue is fully useful as a strict MCP `2026-07-28` server.
2. Skills, Apps, Tasks, Events, Server Cards, and Variants are thin protocol projections over canonical Flue state.
3. Progressive discovery works on ordinary 07-28 clients via stable meta-tools and capability resources.
4. Electric-backed event delivery supports both webhook wake for MCP Events clients and resource/cursor replay for core clients.
5. Long-running operations support both native Tasks and `job://` Resource fallback.
6. The compatibility harness proves semantic equivalence across the client capability matrix.
7. Unsupported extensions disappear without breaking tools, resources, authorization, or durable state.
8. Adding or changing a draft MCP extension requires changing only its projection/adapter, not the Flue runtime architecture.
