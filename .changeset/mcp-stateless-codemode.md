---
'@flue/runtime': minor
'@flue/vite': patch
---

MCP speaks the stateless 2026-07-28 protocol, and Code Mode runs on `@cloudflare/codemode`.

**MCP.** The client is `@modelcontextprotocol/client` 2.2.0 again (it replaces `@earendil-works/pi-mcp`). A connection probes with `server/discover` and carries no session; servers on earlier revisions are negotiated down to the 2025 `initialize` handshake. An agent holds nothing open between wakes: no `subscriptions/listen`, and the 2025-era standalone GET stream is declined. Tool lists are refreshed when the server's cache hint (`ttlMs`) expires, otherwise on the next wake. `useMcpConnection()`, `defineMcpConnection()` and `createMcpConnection()` keep their shape. Changes:

- A connection survives a Durable Object eviction with no saved state, and a 2025-era server that forgets its session (HTTP 404) gets a new one, with the request retried once. Before, the cached connection stayed broken until the instance was evicted.
- Tool names no longer collide. `mcp__<server>__<tool>` is used as is when both parts are letters, digits, `-` and single inner `_`; any other name gets a stable `__<hash>` suffix, so `get-user` and `get_user` (or a `__` inside a name) stay two tools. `mcpToolName(server, tool)` computes the name.
- Images from MCP tools reach the model as images, not as text placeholders.
- A server answering `input_required` (multi-round-trip requests) with input requests fails the call with `McpInputRequiredError`, naming what was asked. Flue has no human-in-the-loop channel inside a turn and advertises no elicitation, sampling or roots capability. A leg carrying only `requestState` is retried by the SDK.
- New: `auth: mcpOAuth({ principal, redirectUrl, scope?, clientMetadataUrl?, clientName? })`. Flue discovers the authorization server, registers (a Client ID Metadata Document when the server supports it, dynamic registration with `application_type: "web"` otherwise), runs the authorization-code flow with PKCE, checks `iss` on the callback (RFC 9207), binds every credential to the authorization server's issuer, and refreshes tokens one at a time. A call that needs the user fails with `McpAuthorizationRequiredError`, carrying the authorization URL. Redirects land on `/__flue/mcp/oauth/callback`, served ahead of `app.ts` by the Worker and the Node server. On Cloudflare, credentials live in the `FlueMcpAuth` Durable Object (one per principal and authorization server): `@flue/vite` binds it as `FLUE_MCP_AUTH` when an agent module calls `mcpOAuth(`, and the wrangler config needs a migration with `new_sqlite_classes: ["FlueMcpAuth"]`. On Node, credentials are kept in memory unless `setMcpOAuthBroker(createMcpOAuthBroker({ storage }))` puts them elsewhere.
- New: `transport: 'stdio'` with `command`, `args`, `env` and `cwd`, on Node only. `McpConnectionDefinition` is now the union `McpHttpConnectionDefinition | McpStdioConnectionDefinition`; code that reads `definition.url` must narrow first. On Cloudflare, a stdio definition fails with an error saying a Worker cannot start processes. The stdio transport is never in a Worker bundle.
- `transport: 'sse'` (legacy HTTP+SSE) is still refused.

**Code Mode.** `useCodeMode()` now runs `@cloudflare/codemode` 0.5.2 executors, and the model-facing tool changed:

- The script is an async arrow function. Globals: `codemode.search(query)` and `codemode.describe(path)` find methods and their TypeScript types inside the sandbox, so large MCP catalogs cost the prompt nothing; `codemode.store(key, value)` / `codemode.load(key)` keep JSON values per conversation (in a Pi document, kept only when the script succeeds — before, `store()` writes were dropped); `tools.<name>(input)` calls the agent's own tools; `<server>.<method>(input)` calls an MCP server, returning its typed `structuredContent`, or `{ content }` with images. Returning content blocks shows images to the model.
- Options are `{ executor, maxOutputTokens? }`. `timeoutMs` and `memoryLimitBytes` moved to the executors.
- Cloudflare: `createCodemodeExecutor({ loader: env.LOADER, timeoutMs?, cpuMs?, subRequests?, concurrency? })` from `@flue/runtime/cloudflare` replaces `DynamicWorkerCodemodeExecutor`. Every script runs in a fresh Dynamic Worker with `globalOutbound: null`, `limits: { cpuMs: 30000, subRequests: 1000 }` by default, and at most 4 at once per instance (the platform allows 10 per Durable Object).
- Node: `new NodeCodemodeExecutor({ timeoutMs?, memoryLimitMb? })` from `@flue/runtime/node` runs scripts with `node:vm` in a worker thread. It is not a security boundary.
- Approvals (`requiresApproval`), `codemode.step()` and snippets are not offered: they live in `@cloudflare/codemode`'s runtime, which is a Durable Object Facet, and Facets are not part of Flue's Cloudflare architecture.
- The `CodemodeExecutor`, `CodemodeResult` and related types from `@earendil-works/pi-codemode` are no longer exported; use `Executor` from `@cloudflare/codemode`.
