# fabric-live-artifacts Worker

Cloudflare Worker + `LiveArtifactHub` Durable Object for the Live-artifacts read gateway (A5), registry and blob storage (A3), and producer fence (A6).

## Staging topology

- **Public URL:** `https://fabric-live-artifacts.<workers-subdomain>.workers.dev` (`workers_dev: true`). Subdomain is per-account (Workers & Pages → Workers configuration → Subdomain).
- **Electric agents:** existing VPC service `01a0f462-e30b-7df3-bae8-e64c24c720c7` → `fabric-society-electric:4437` via `FLUE_STREAMS` — do not add a new VPC service or tunnel hostname.
- **R2:** bucket `fabric-live-artifacts` in account `865babfb7b889533bb9357f7c79f1222`.
- **Electric sync (:3000):** not exposed on the Worker; operators use kubectl port-forward (see nymphai `fabric/live-artifacts/staging/`).

## Deploy (from nymphai)

```bash
bash fabric/live-artifacts/staging/deploy-gateway-worker.sh
```

Secrets: `LIVE_ARTIFACTS_VIEWER_TOKEN_SECRET`, `FLUE_STREAMS_TOKEN` (Electric `ELECTRIC_SECRET`).

## Dry-run (no credentials)

```bash
pnpm --filter @flue/fabric-live-artifacts deploy:dry-run
```
