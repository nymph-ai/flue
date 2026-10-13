# p22-live-artifacts Worker

Cloudflare Worker + `P22ArtifactHub` Durable Object for the P22 read gateway (A5), registry and blob storage (A3), and producer fence (A6).

## Staging topology

- **Public URL:** `https://p22-live-artifacts.<workers-subdomain>.workers.dev` (`workers_dev: true`). Subdomain is per-account (Workers & Pages → Workers configuration → Subdomain).
- **Electric agents:** existing VPC service `01a0f462-e30b-7df3-bae8-e64c24c720c7` → `fabric-society-electric:4437` via `FLUE_STREAMS` — do not add a new VPC service or tunnel hostname.
- **R2:** bucket `p22-live-artifacts` in account `865babfb7b889533bb9357f7c79f1222`.
- **Electric sync (:3000):** not exposed on the Worker; operators use kubectl port-forward (see nymphai `fabric/live-artifacts/staging/`).

## Deploy (from nymphai)

```bash
bash fabric/live-artifacts/staging/deploy-gateway-worker.sh
```

Secrets: `P22_VIEWER_TOKEN_SECRET`, `FLUE_STREAMS_TOKEN` (Electric `ELECTRIC_SECRET`).

## Dry-run (no credentials)

```bash
pnpm --filter @flue/p22-live-artifacts deploy:dry-run
```
