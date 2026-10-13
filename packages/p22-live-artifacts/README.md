# p22-live-artifacts Worker

Cloudflare Worker + `P22ArtifactHub` Durable Object for the P22 read gateway (A5), registry and blob storage (A3), and producer fence (A6).

## Deploy (staging)

From the monorepo root with Cloudflare API token and SOPS secrets loaded:

```bash
bash fabric/live-artifacts/staging/deploy-gateway-worker.sh
```

Secrets: `P22_VIEWER_TOKEN_SECRET`, `FLUE_STREAMS_TOKEN` (Electric `ELECTRIC_SECRET`).

## Dry-run (no credentials)

```bash
pnpm --filter @flue/p22-live-artifacts deploy:dry-run
```
