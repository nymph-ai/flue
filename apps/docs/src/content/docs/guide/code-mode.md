---
title: Code Mode
description: Let the model write code against your tools and MCP servers, with durable approvals.
lastReviewedAt: 2026-10-01
---

Code Mode gives the model one tool, `codemode`, that runs JavaScript it writes. Inside the script, the agent's own tools and every connected [MCP server](/docs/guide/mcp/) are typed globals, so the model can loop, filter and combine their results in one step, and only what the script returns reaches the conversation. Discovery happens inside the sandbox too: a server with hundreds of tools costs the prompt nothing.

Code Mode is [`@cloudflare/codemode`](https://developers.cloudflare.com/agents/tools/codemode/), and it runs on the [Cloudflare target](/docs/guide/cloudflare-target/) only.

## Turn it on

```ts title="src/agents/triage.ts"
'use agent';
import { useCodeMode, useMcpConnection, useModel } from '@flue/runtime';
import { github } from '../connections/github.ts';

export function Triage() {
  useModel('anthropic/claude-sonnet-4-6');
  useMcpConnection(github);
  useCodeMode({ requiresApproval: ['github.create_issue', 'github.merge_pull_request'] });
  return 'Triage new issues and pull requests.';
}
```

`@flue/vite` does the wiring when an agent module calls `useCodeMode(`: it adds the `LOADER` Worker Loader binding (Dynamic Workers, which need the Workers Paid plan) and exports the runtime's facet class, `CodemodeRuntime`, from the generated Worker entry. Your wrangler config needs nothing new, but the build fails, saying what to change, if it sets the `disable_ctx_exports` compatibility flag or declares an agent class under `new_classes` instead of `new_sqlite_classes`.

A Node build of an app that calls `useCodeMode()` fails: Node has neither Durable Object Facets nor Dynamic Workers.

## What the model writes

The model writes an async arrow function. Its globals:

| Global | Purpose |
| --- | --- |
| `codemode.search(query)` | Ranked search over every method and saved snippet |
| `codemode.describe(path)` | TypeScript declarations for a method (`"github.create_issue"`), a namespace (`"github"`) or a snippet |
| `codemode.step(name, fn)` | Run nondeterministic or side-effectful work once; its result is replayed when the script resumes |
| `codemode.run(name, input)` | Run a saved [snippet](#snippets) |
| `codemode.store(key, value)` / `codemode.load(key)` | JSON values kept across `codemode` calls in this conversation; writes are kept only when the script completes |
| `tools.<name>(input)` | The agent's own tools |
| `<server>.<method>(input)` | An MCP server's tools, returning the server's structured result when it declares one |

```ts
async () => {
  const found = await codemode.search('open pull requests');
  const docs = await codemode.describe(found.results[0].path);
  const prs = await github.list_pull_requests({ owner: 'acme', repo: 'api', state: 'open' });
  return prs.filter((pr) => pr.draft === false).map((pr) => pr.number);
};
```

Scripts have no network (`fetch` and `connect` are blocked) and no filesystem: everything goes through the namespaces. Names are turned into JavaScript identifiers (`get-user` becomes `get_user`); two names that would collide both get a short hash suffix, which `codemode.search` shows.

## Where it runs and what it keeps

Each agent has one Code Mode runtime, a [Durable Object Facet](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/) of the agent's Durable Object with its own SQLite database. It records every method call and step of every execution, the actions waiting for approval, and saved snippets, so an execution paused for approval survives the agent hibernating or being evicted. Each script runs in a fresh Dynamic Worker, with a 30-second CPU limit, at most 1 000 calls back to the host, and at most four scripts at once per agent. Change those with your own executor:

```ts
import { env } from 'cloudflare:workers';
import { createCodemodeExecutor } from '@flue/runtime/cloudflare/codemode';

useCodeMode({ executor: createCodemodeExecutor({ loader: env.LOADER, cpuMs: 60_000 }) });
```

`codemode.store` values live in the conversation, not in the runtime: they follow the conversation's history like the rest of the agent's state.

## Approvals

`requiresApproval` marks the methods that need a person: sandbox paths, a whole namespace (`'github.*'`), or a predicate over each method. The predicate sees the MCP server's [annotations](/docs/guide/mcp/#advanced-making-a-direct-mcp-server-connection):

```ts
useCodeMode({
  requiresApproval: (method) => method.annotations?.destructiveHint === true,
});
```

When a script reaches such a call, the runtime logs it as pending and stops the script. Once the question is answered, the same script runs again: every call already made is served from the log instead of being repeated, the approved call runs for real, and the script carries on. A rejection ends the execution; calls made before it are not undone. Because the script is replayed, everything outside method calls must be deterministic: wrap random values and timestamps in `codemode.step()`, and await method calls one at a time.

### Answering approvals

An approval is a question, and questions to people are entity events: they need the agent's entity streams (Electric). While it waits, the `codemode` call stays open inside the agent's turn — the model is not called again — and nothing runs; the agent can hibernate or be evicted, and the call continues where it stopped once the answer arrives.

The question is published as one `input-requested` event on the agent's `flue/v1/<agent>/<id>/questions` stream, which a UI (or another agent) can watch. It carries the question (`kind: 'codemode-approval'`, the pending calls and their arguments), a one-line summary, and where to answer. Answer it with the SDK, or over HTTP on the agent's router:

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({ url: 'https://example.com/agents/deployer/run-42' });
const [question] = await client.questions();
await client.answer(question.id, { kind: 'codemode-approval', decision: 'approve' });
// or: { kind: 'codemode-approval', decision: 'reject', reason: 'Not on a Friday.' }
```

```sh
curl https://example.com/agents/deployer/run-42/questions
curl -X POST https://example.com/agents/deployer/run-42/questions/<id>/answer \
  -H 'content-type: application/json' \
  -d '{"answer":{"kind":"codemode-approval","decision":"approve"}}'
```

An answer is an `input-answered` event appended to the agent's inbox — the same path any participant's message takes — which wakes the agent. The first answer wins; a duplicate, a late answer, or an answer to an unknown question changes nothing and is logged. `useQuestions()` routes questions further and bounds the wait:

```ts
import { useQuestions } from '@flue/runtime';

useQuestions({
  // Also deliver every question to this agent's inbox; it answers with its answer_question tool.
  responder: { type: 'reviewer', id: 'oncall' },
  // Reject a question nobody answered within an hour (the agent's alarm fires at the deadline).
  timeoutMs: 3_600_000,
});
```

A question that expires fails the call like a rejection. The agent's own durability limit still applies to the whole turn, the wait included (one hour by default): set `durability.timeoutMs` on the agent when approvals may take longer.

## Snippets

A snippet is a script that already worked, saved so the model can find it with `codemode.search` and re-run it with `codemode.run(name, input)`. You decide what is worth keeping: each `codemode` result carries its `executionId` in the tool result's details, and `codemodeRuntime()` saves it, from anywhere inside the agent (a tool, a lifecycle hook):

```ts
import { codemodeRuntime } from '@flue/runtime/cloudflare/codemode';

await codemodeRuntime().saveSnippet('open-prs', {
  executionId,
  description: 'List open, non-draft pull requests for a repository.',
});
```

`codemodeRuntime()` also lists `executions()`, `pending()` approvals and `snippets()`, and deletes snippets with `deleteSnippet(name)`. A snippet records the namespaces it used and refuses to run when one is no longer connected.

## Next steps

- [MCP](/docs/guide/mcp/) — connecting the servers Code Mode calls.
- [Tools](/docs/guide/tools/) — the agent's own tools, available as `tools.*`.
- [Cloudflare target](/docs/guide/cloudflare-target/) — the Worker Code Mode runs in.
