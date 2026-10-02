---
'@flue/runtime': minor
'@flue/vite': patch
---

Agent instances follow the Cloudflare-native shape (`docs/cloudflare-native.md`):

- Pi Durable runs on Pi's own `SqliteStorage` inside the Durable Object, over the documented `SqliteDatabase` adapter for `ctx.storage.sql`. Pi's commits are no longer published anywhere: the commit outbox, producer epochs and fencing, and rebuilding an instance from a log are gone. Existing Durable Objects keep their Pi state; their public conversation is rebuilt once from it, and clients re-hydrate through a `conversation-reset`.
- The public conversation wire is cached in the instance's SQLite and fed from Pi's commits as they happen. Streamed partials are buffered and written a page at a time, so a streamed answer costs two rows written.
- Electric carries entity events only: inboxes, published events and observed world streams. A send or publish appends one event with a deterministic id (`{self}/{taskId}/{callId}` inside a tool call) as a plain POST; a replayed tool call appends the same event again and the receiver admits it once.
- A verified Electric webhook rings the instance's doorbell (`__flueWake({ stream, head })`): the high-water mark and `setAlarm(now)` are written together, and the webhook is acked through its callback once that is durable — never with a `{ done: true }` reply. The alarm drains each stream from its committed cursor in bounded chunks and re-arms while it is behind.
- Every Flue document now stores a full base every 16 changes, so reading one no longer replays its whole history; the receipt index and the per-conversation run record are bounded.
- `@flue/runtime/qualification` exposes entity paths, the configured streams and the Durable Object SQLite facade with its row counters instead of the log rebuild and split-brain probes.
