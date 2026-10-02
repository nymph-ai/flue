---
'@flue/runtime': minor
'@flue/sdk': minor
---

Questions to people are entity events (docs/cloudflare-native.md rule 9): Code Mode approvals and MCP `input_required` (elicitation) now wait for an answer instead of failing.

- A question parks inside Pi Durable: the asking tool call creates a `flue.question` task under its own tool task and waits on it, so the turn stays open with no model round trip and nothing runs while it waits. The question is published once as an `input-requested` event (its id derived from the question id) on the agent's new `flue/v1/{type}/{id}/questions` stream.
- An answer is an `input-answered` event in the agent's inbox; the doorbell and the alarm pump admit it like any inbox event. Code Mode then continues the paused execution in its runtime facet; the MCP client sends the request again with `inputResponses` and the server's `requestState`, byte for byte. If the agent was evicted meanwhile, Pi reruns the call and it continues from the parked question. The `codemode` tool and MCP tools are registered `replay: "safe"` for that; a rerun of a call that never parked still settles as interrupted. An answer is marked applied before it is applied, so a crash while applying it is never applied twice.
- The first answer wins. A duplicate or late answer, an answer to an unknown or settled question, or one of the wrong kind changes nothing and is reported.
- New: `useQuestions({ responder?, timeoutMs? })`. `responder` also delivers every question to that entity's inbox (another agent sees it as an `input.requested` signal and answers with the new `answer_question` entity tool); `timeoutMs` expires an unanswered question at the agent's alarm, failing the call. The agent's durability timeout still bounds the whole turn, the wait included.
- New routes on every agent router: `GET /:id/questions` lists pending questions; `POST /:id/questions/:questionId/answer` with `{ answer, answerId?, from? }` appends the answer to the agent's inbox and rings its doorbell (404 unknown, 409 already settled). `@flue/sdk`'s client gains `questions()` and `answer(questionId, answer, { answerId?, from? })`.
- A parked question costs a fixed number of rows (its document, an index entry, its task and the call's record); a wake while it waits writes nothing. The live-task backstop does not wake an agent whose only work waits on parked questions, and reopening such an agent does not count against its attempt budget.
- `codemode.store()`'s document now stores a base every four writes, so a cold read no longer replays every write (nymph-ai/nymphai #3862).
