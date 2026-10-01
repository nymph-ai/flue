---
title: Code Mode
description: Let the model write code against your tools, MCP servers and classifier models, with durable approvals.
lastReviewedAt: 2026-10-01
---

Code Mode gives the model one tool, `codemode`, that runs JavaScript it writes. Inside the script, the agent's own tools and every connected [MCP server](/docs/guide/mcp/)'s tools are functions on `tools`, so the model can loop, filter, run calls concurrently and combine their results in one step, and only what the script outputs reaches the conversation.

Code Mode is [Pi](https://pi.dev)'s, `@earendil-works/pi-codemode`: scripts see exactly what they see in Pi's coding agent, so a script written for Pi runs here unchanged. Each script runs in a fresh [QuickJS](https://github.com/quickjs-ng/quickjs) VM inside the agent itself — in its Durable Object on the [Cloudflare target](/docs/guide/cloudflare-target/), in its process on Node.

## Turn it on

```ts title="src/agents/triage.ts"
'use agent';
import { useCodeMode, useMcpConnection, useModel } from '@flue/runtime';
import { github } from '../connections/github.ts';

export function Triage() {
  useModel('anthropic/claude-sonnet-4-6');
  useMcpConnection(github);
  useCodeMode({
    requiresApproval: ['mcp__github__create_issue', 'mcp__github__merge_pull_request'],
  });
  return 'Triage new issues and pull requests.';
}
```

On Cloudflare, `@flue/vite` does the wiring when an agent module calls `useCodeMode(`: the generated Worker entry imports `@flue/runtime/cloudflare/codemode`, which brings QuickJS's WebAssembly module, compiled at build time (workerd compiles no WebAssembly at run time). Your wrangler config needs nothing new. A custom `main` that does not re-export `virtual:flue/worker` imports that module itself.

## What the model writes

The script is the body of an async function: top-level `await` and `return` work. Its globals:

| Global                                                                             | Purpose                                                                                                          |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tools.<name>(args)`                                                               | The agent's own tools, and each MCP server's as `tools.mcp__<server>__<tool>`                                    |
| `ALL_TOOLS`, `searchTools(query)`, `describeTool(name)`, `describeNamespace(name)` | Find tools and read their TypeScript declarations                                                                |
| `text(value)`, `image(item)`, `console.log(…)`, `return value`                     | What reaches the conversation                                                                                    |
| `exit()`                                                                           | End the script successfully right away                                                                           |
| `store(key, value)` / `load(key)`                                                  | JSON values kept across `codemode` calls in this conversation; writes are kept only when the script succeeds     |
| `models.getModelOfType(…)`, `models.classify(model, context)`                      | The model catalog, and classifier models such as TypeSafe's Jev; at most four classifications at once per script |

```js
const { issues } = await tools.mcp__linear__list_issues({ team: 'Pi', state: 'open', limit: 250 });
const jev = await models.getModelOfType('classifier', 'typesafe', 'jev-latest');
const questions = {
  frustration: {
    type: 'choice',
    instructions: 'Judge only the emotional tone of the people writing.',
    criteria: { none: 'Neutral or friendly', mild: 'Annoyed', high: 'Angry or fed up' },
  },
};
const results = await Promise.all(
  issues.map(async (issue) => {
    const { comments } = await tools.mcp__linear__list_comments({ issueId: issue.identifier });
    const c = await models.classify(jev, { state: { ...issue, comments }, questions });
    return { id: issue.identifier, ...c.answers.frustration };
  }),
);
store('frustration', results);
return results.filter((r) => r.choice !== 'none').map((r) => r.id);
```

An MCP tool resolves to its whole `CallToolResult` (`content`, `structuredContent`, `isError`, without `_meta`), as in Pi; the agent's own tools resolve to their output. A call that fails rejects with the tool's error text. The tool's description lists the tools' TypeScript declarations within a budget of about 3 000 tokens; scripts find the rest with `searchTools()`. A script may start with an options line, `// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}`.

Scripts have no network, no timers, no filesystem and no host APIs: everything goes through `tools` and `models`.

## Where it runs and what it keeps

Each script gets a fresh QuickJS VM in the agent's own isolate, gone when the script ends. Nothing is billed per script: on Cloudflare, its CPU runs while the agent's Durable Object is already awake, waiting on the model and the tools. Because the VM shares the agent's thread, it is bounded:

- memory: 32 MiB by default (`useCodeMode({ memoryLimitBytes })`); an allocation beyond it throws `InternalError: out of memory` inside the script;
- CPU: QuickJS checks for interruption as it runs, and a script that keeps computing is stopped well within a Durable Object's 30-second CPU limit;
- time: none by default, as in Pi — a script may wait on an approval — unless the script's `timeout_ms` or `useCodeMode({ timeoutMs })` sets one.

`store()` values live in the conversation: they follow the conversation's history like the rest of the agent's state. Nothing else is kept, except for a script waiting on a question (below).

## Approvals

`requiresApproval` marks the tools that need a person: tool names as scripts call them, `*` patterns (`'mcp__github__*'`), or a predicate over each tool. The predicate sees the MCP server's [annotations](/docs/guide/mcp/#advanced-making-a-direct-mcp-server-connection):

```ts
useCodeMode({
  requiresApproval: (tool) => tool.annotations?.destructiveHint === true,
});
```

When a script calls such a tool, the call waits while a person is asked; an approval runs it and the script carries on, and a rejection rejects that call inside the script with an Error saying so. Calls made before are not undone. An MCP server that answers `input_required` (an elicitation) inside a script is asked the same way.

A waiting script lives only in memory, so its earlier calls' results are written down the moment it first asks. If the agent is evicted while it waits, the script runs again once the answer arrives: the calls it already made are answered from that record instead of being repeated, and the call that waited runs once, with the answer. Scripts that never ask write nothing.

### Answering approvals

An approval is a question, and questions to people are entity events: they need the agent's entity streams (Electric). While it waits, the `codemode` call stays open inside the agent's turn — the model is not called again — and nothing runs; the agent can hibernate or be evicted, and the call continues where it stopped once the answer arrives.

The question is published as one `input-requested` event on the agent's `flue/v1/<agent>/<id>/questions` stream, which a UI (or another agent) can watch. It carries the question (`kind: 'codemode-approval'`, the waiting call and its arguments), a one-line summary, and where to answer. Answer it with the SDK, or over HTTP on the agent's router:

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

## Next steps

- [MCP](/docs/guide/mcp/) — connecting the servers Code Mode calls.
- [Tools](/docs/guide/tools/) — the agent's own tools, available as `tools.*`.
- [Cloudflare target](/docs/guide/cloudflare-target/) — the Worker Code Mode runs in.
