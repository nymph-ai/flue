# Autonomous Knowledge Library

Curators and librarians on Pi v1.0.0 Durable Objects, maintaining an autonomous knowledge base in **Google Open Knowledge Format (OKF)** viewable as a native **Obsidian** vault with graph view and backlinks.

Each instance is an addressable entity whose inbox and events stream live on Electric Agents (reached through the `FLUE_STREAMS` Workers VPC binding) and whose Pi state lives in its own Durable Object SQLite.

- `curator`: observes the Hacker News world stream (`v1/stream/world/hn/items`), synthesizes significant technical literature into OKF notes with `[[wikilinks]]`, saves them to the Library Vault (`stories/<id>.md`), updates `index.md`, and broadcasts recommendations to Electric (`v1/stream/library/curator/recommendations`).
- `librarian`: maintains the Obsidian knowledge graph, catalogs concepts (`concepts/<slug>.md`), verifies backlinks, and organizes the central Map of Content (`index.md`).
- `steward`: runs operations on the library's `ops` MCP server, directly and via Code Mode scripts with approval gates.
- `sage`: answers with the real model (`meta/muse-spark-1.3-contributor`).
- `alice` and `bob`: peer librarians coordinating with `send_message`.

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
- `log.md`: Append-only audit trail of all curator and librarian actions.

### HTTP Vault Endpoints
- `GET /wiki/` or `GET /wiki/index.md`: Returns central Map of Content.
- `GET /wiki/stories/:id`: Returns raw OKF story markdown.
- `GET /wiki/concepts/:slug`: Returns raw concept note.
- `GET /wiki/manifest`: JSON manifest of all vault files, hashes, and topics.
- `GET /wiki/vault.zip`: **1-Click Obsidian Vault Download** — generates and downloads the complete `.zip` archive ready to open directly in Obsidian!

### Obsidian Setup
1. **Direct Download**: Download `https://library.<subdomain>.workers.dev/wiki/vault.zip`, unzip to an Obsidian folder, and open as a vault.
2. **Cloudflare R2 / S3 Sync**: Configure Obsidian plugin *Remotely Save* pointing to the R2 bucket `library-wiki`.

---

## Models

`LIBRARY_MODEL` picks the model:

- `scripted` (default): a deterministic provider over pi-ai's faux model (`src/scripted.ts`).
- `live`: the real model `LIVE_MODEL`, Muse Spark 1.3 Contributor on Meta's Model API (`meta/muse-spark-1.3-contributor`), keyed by the `META_API_KEY` secret.
