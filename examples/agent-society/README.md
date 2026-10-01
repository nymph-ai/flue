# Agent society

Five `'use agent'` agents — `alice`, `bob`, `curator`, `steward` and `sage` — on Pi Durable, each
instance an addressable entity (nymph-ai/nymphai #3752) in the shape of
`docs/cloudflare-native.md`. Each instance's Pi state lives in its own Durable
Object SQLite; its inbox and events stream live on an Electric Agents server,
reached through the `FLUE_STREAMS` Workers VPC binding. Electric rings a
sleeping instance's doorbell with a signed webhook to `/__flue/streams/wake`,
and the instance's alarm admits what arrived.

- `alice` and `bob` talk to each other with `send_message`.
- `curator` observes the Hacker News world stream (`v1/stream/world/hn/items`)
  and is woken by new items.
- `steward` runs operations on the `ops` MCP server (`society-ops`, a
  stateless 2026-07-28 server reached through the `OPS` service binding with
  the `OPS_MCP_TOKEN` bearer secret), directly and from Code Mode scripts.
  `ops.record` needs a person's approval, and `ops.deploy` answers
  `input_required` (an elicitation): both become questions on the steward's
  `flue/v1/steward/<id>/questions` stream (`useQuestions()`), answered with
  `POST /agents/steward/<id>/questions/<questionId>/answer`.
- `sage` always answers with Workers AI (`SAGE_MODEL`) through the `AI` binding.

## Models

`SOCIETY_MODEL` picks the model:

- `scripted` (default): a deterministic provider over pi-ai's faux model
  (`src/scripted.ts`). Only the model's choices are scripted; every turn still
  runs Pi Durable end to end. A prompt is a list of commands (`send bob/b1
ping`, `spawn bob kid 50`, `observe <stream> <key> <from>`, `chain 3`, …).
- `workers-ai`: Workers AI through the `AI` binding (`WORKERS_AI_MODEL`).

## Qualification build

`QUALIFICATION=1 vite build` compiles in a test-only surface, served when the
deployment also sets `QUALIFICATION=1` and behind the `SOCIETY_TOKEN` secret:

- Durable Object hooks (`src/qualification/agent-hooks.ts`): rows read and
  written, the wake book, the conversation cache, an activity log per
  instance, forced eviction;
- `/qual/*` routes (`src/qualification/install.ts`), including hand-rung
  doorbells and read-only stream reads.

Any other build leaves all of it out. The monorepo deploys and drives this app
with `fabric/society/deploy/deploy-society.sh` and
`fabric/society/qualification/`.
