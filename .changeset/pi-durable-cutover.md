---
'@flue/runtime': minor
'@flue/vite': patch
'@flue/cli': patch
---

Agents now run on Pi Durable. Each agent instance keeps its Pi state in its own SQLite — the Durable Object's on Cloudflare, `node:sqlite` on Node — through Pi's own `SqliteStorage`, and Flue projects it onto the same public conversation wire (`AgentConversationSnapshot` and `ConversationStreamChunk`), so `@flue/sdk`, `@flue/react` and the read routes are unchanged. The authoring surface is also unchanged: `'use agent'`, every `use*` hook, `createAgentRouter`, `dispatch`, channels and telemetry.

The persistence format version is now `2`. Stores written at format `1` stay readable. The first time a pre-upgrade instance is opened, its conversation is imported into Pi in a single step. The import keeps the instance's identity, its persistent state, its model context (the transcript and the latest compaction summary) and its public history. Clients holding pre-upgrade offsets receive a `conversation-reset` and re-hydrate. The import drops attachment bytes from model context, does not resume unsettled submissions, and does not deduplicate keyed dispatches across the upgrade. Once the new format is written, a downgrade cannot read it.

New: `setStreams(electricStreams({ baseUrl, fetch?, headers?, webhook? }))` makes agent instances addressable entities whose inboxes and published events live on an Electric (Durable Streams) server; Pi's own state never leaves the instance. With no code, the same can be set from the deployment environment: `FLUE_STREAMS_URL`, `FLUE_STREAMS` (service binding), `FLUE_STREAMS_TOKEN`, `FLUE_STREAMS_JWKS_URL` and `FLUE_STREAMS_WEBHOOK_URL`. When it is configured, the Cloudflare Worker serves the entity wake route at `/__flue/streams/wake`.

Behaviour changes:

- A tool call cut off by the length limit is no longer executed.
- An aborted tool's error text is now "Tool X was aborted".
- Context overflow is compacted before the request rather than after the failed answer.
- `useAgentStart` content goes into the request; it is no longer a transcript message.
- `task({ result })` is not supported.
- Changes to whether a sandbox is present take effect at the next render.
- On Node, each instance's Pi state is an SQLite file under `FLUE_PI_DIR` when that is set, and in memory otherwise; interrupted work resumes the next time its instance is opened.
- `AgentSubmissionStore` and `PersistenceStores.submissionStore` are deprecated and no longer written.
