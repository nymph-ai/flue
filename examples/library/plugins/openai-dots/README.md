# Fabric Knowledge Library Plugin for OpenAI Dots

This directory contains the production OpenAI Dots (GPT-6 Astra) integration package for the Fabric Knowledge Library.

## Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `https://library.nymphai.workers.dev/mcp` | POST / GET / OPTIONS | MCP 2.0 JSON-RPC & capability discovery |
| `https://library.nymphai.workers.dev/.well-known/ai-plugin.json` | GET | OpenAI Plugin Manifest |
| `https://library.nymphai.workers.dev/.well-known/mcp.json` | GET | MCP 2.0 Protocol Manifest |
| `https://library.nymphai.workers.dev/openapi.json` | GET | OpenAPI 3.1.0 Specification |
| `https://library.nymphai.workers.dev/mcp/tasks/:id` | GET | Inspect durable task state in DO SQLite |
| `https://library.nymphai.workers.dev/mcp/results/:id` | GET | Retrieve completed durable result & OKF note |
| `https://library.nymphai.workers.dev/mcp/events` | GET | Query historical task event stream |
| `https://library.nymphai.workers.dev/mcp/deliveries/:taskId` | GET | Delivery audit trail & telemetry |
| `https://library.nymphai.workers.dev/mcp/test-callback` | POST / GET / DELETE | Live webhook test & signature verification harness |

---

## Quickstart for OpenAI Dots & ChatGPT

### Step 1: Register Plugin
In ChatGPT / OpenAI Developer mode or Dots platform:
1. Provide the plugin URL: `https://library.nymphai.workers.dev`
2. OpenAI will automatically fetch `/.well-known/ai-plugin.json` and validate the schema against `/openapi.json`.
3. Preflight `OPTIONS /mcp` succeeds with 204 and complete CORS headers.

### Step 2: Autonomous Conversation Wake
1. Dots registers a webhook callback via `events/subscribe`:
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "events/subscribe",
     "params": {
       "callbackUrl": "https://chatgpt.com/api/mcp/callbacks/<thread-id>",
       "secret": "<dots-hmac-secret>",
       "filter": { "correlationId": "<thread-id>" }
     }
   }
   ```
2. Dots submits an asynchronous job (e.g. `curate` or `synthesize`):
   ```json
   {
     "jsonrpc": "2.0",
     "id": 2,
     "method": "tools/call",
     "params": {
       "name": "submit_task",
       "arguments": {
         "task_type": "curate",
         "correlation_id": "<thread-id>",
         "payload": {
           "native_id": "49930412",
           "title": "Custom Page Fault Handling with Bpf_fault",
           "url": "https://dl.acm.org/doi/10.1145/3830418.3843896"
         }
       }
     }
   }
   ```
3. The conversation enters **idle/suspended state**.
4. In the background, Cloudflare Durable Object SQLite processes the job and sends a signed POST request to the callback URL with `x-mcp-event-signature: sha256=<hmac>`.
5. The signature is verified and the conversation is **woken up**!
6. Dots calls `get_result(taskId)` to present verified sources, OKF wikilinks, and artifacts.
7. Dots calls `acknowledge_result(taskId)` to record client receipt.
