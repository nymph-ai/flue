# Agent society

Three `'use agent'` agents — `alice`, `bob` and `curator` — on Pi Durable, each
instance an addressable entity (nymph-ai/nymphai #3752). Every instance's
canonical Pi log, inbox and events stream live on an Electric Agents server,
reached through the `FLUE_STREAMS` Workers VPC binding; Electric wakes a
sleeping instance with a signed webhook to `/__flue/streams/wake`.

- `alice` and `bob` talk to each other with `send_message`.
- `curator` observes the Hacker News world stream (`v1/stream/world/hn/items`)
  and is woken by new items.

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

- fault injection in front of Electric (`src/qualification/faults.ts`): crash
  before the Pi log POST, after it, or after N acknowledged commits;
- Durable Object hooks (`src/qualification/agent-hooks.ts`): StreamStorage
  state, Pi index digests, an activity log per instance, forced eviction;
- `QualReplica` (`src/qualification/replica.ts`): rebuild an instance from its
  log alone and compare, probe producer fencing, act as a second writer;
- `/qual/*` routes (`src/qualification/install.ts`).

Any other build leaves all of it out. The monorepo deploys and drives this app
with `fabric/society/deploy/deploy-society.sh` and
`fabric/society/qualification/`.
