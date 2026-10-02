# Autonomous Knowledge Vault

A single Pi agent running **Muse Spark 1.3 Contributor** (`meta/muse-spark-1.3-contributor`), maintaining a technical knowledge base in **Google Open Knowledge Format (OKF)** viewable as a native **Obsidian** vault with graph view and backlinks.

The agent observes the Hacker News world stream (`v1/stream/world/hn/items`), synthesizes significant technical literature into OKF notes with `[[wikilinks]]`, automatically maintains concept cards and backlinks, saves notes to the R2 Library Vault (`stories/<id>.md`), updates `index.md`, and broadcasts recommendations to Electric (`v1/stream/library/curator/recommendations`).

The agent inbox and events stream live on Electric Agents (reached through the `FLUE_STREAMS` Workers VPC binding) and its Pi state lives in its Durable Object SQLite.

---

## Google Open Knowledge Format (OKF) & Obsidian Vault

Every curated note is stored in standard Markdown with YAML frontmatter:

```markdown
---
schema_version: okf/v1
id: "hn-49930412"
type: story
title: "It's the Kernel's Fault: Custom Page Fault Handling with Bpf_fault"
resource: "https://dl.acm.org/doi/10.1145/3830418.3843896"
source: hackernews
native_id: "49930412"
timestamp: "2026-10-02T07:17:09Z"
curator: "curator"
curator_model: "meta/muse-spark-1.3-contributor"
significance_score: 0.92
topics:
  - "Systems"
  - "Linux Kernel"
  - "eBPF"
concepts:
  - "[[bpf_fault]]"
  - "[[userfaultfd]]"
  - "[[Demand Paging]]"
tags:
  - "systems"
  - "ebpf"
  - "kernel"
---

# It's the Kernel's Fault: Custom Page Fault Handling with Bpf_fault

> **Curator Assessment**: High-impact kernel primitive enabling user-defined fault handlers in eBPF. Directly relevant to zero-copy agent snapshot resumption.
```

### Vault Structure
- `stories/<id>.md`: Curated story notes with executive summary, technical significance, and concept links.
- `concepts/<slug>.md`: Concept cards tracking definition, provenance, and backlinks across stories.
- `index.md`: Map of Content (MOC) cataloging all stories, concepts, and system statistics.
- `log.md`: Append-only audit trail of all curation actions.

### HTTP Vault & Git Sync Endpoints
- `GET /wiki/` or `GET /wiki/index.md`: Returns central Map of Content.
- `GET /wiki/stories/:id`: Returns raw OKF story markdown.
- `GET /wiki/concepts/:slug`: Returns raw concept note.
- `GET /wiki/manifest`: JSON manifest of all vault files, hashes, and topics.
- `GET /wiki/git/info`: Returns Cloudflare Artifacts Git repository metadata and clone instructions.
- `POST /wiki/git/token`: Mints scoped Git access tokens for `obsidian-git` or standard git CLI.

### Obsidian Setup Options
1. **Cloudflare Artifacts (Native Git Sync — Recommended)**:
   - Install the **Obsidian Git** plugin in Obsidian.
   - Request a scoped token via `POST /wiki/git/token` (or query `/wiki/git/info`).
   - Clone the vault repository from the Cloudflare Artifacts Git remote URL using the token.
   - Enjoy automated two-way Git syncing, diffs, and version history.
2. **Cloudflare R2 / S3 Sync**: Configure Obsidian plugin *Remotely Save* pointing to the R2 bucket `library-vault`.

### OpenAI Dots & MCP Integration
The vault exposes a standard **Model Context Protocol (MCP)** server on `/mcp` (JSON-RPC 2.0, protocol `2024-11-05`):
- `GET /mcp`: Server discovery metadata and tool catalog.
- `POST /mcp`: Standard MCP handler supporting `initialize`, `tools/list`, and `tools/call`.

**Tools available to OpenAI Dots & AI Coworkers:**
- `search_vault({ query, type })`: Search technical stories and concepts in the knowledge graph.
- `get_note({ path })`: Retrieve raw OKF markdown notes (`stories/*.md`, `concepts/*.md`, `index.md`).
- `curate_story(...)`: Allow Dots to submit new research and technical papers directly into the vault.
- `get_git_sync_info()`: Retrieve Cloudflare Artifacts Git clone URL and setup instructions.

---

## Models

`LIBRARY_MODEL` picks the model:

- `scripted` (default): a deterministic provider over pi-ai's faux model (`src/scripted.ts`).
- `live`: the real model `LIVE_MODEL`, Muse Spark 1.3 Contributor on Meta's Model API (`meta/muse-spark-1.3-contributor`), keyed by the `META_API_KEY` secret.
