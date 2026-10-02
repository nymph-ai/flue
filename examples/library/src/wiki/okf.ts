/**
 * Google Open Knowledge Format (OKF) serializing, parsing, and Obsidian integration.
 */
import type { OKFConceptNote, OKFLogEntry, OKFStoryNote } from './types.ts';

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function extractWikilinks(markdown: string): string[] {
	const matches = markdown.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
	const links = new Set<string>();
	for (const match of matches) {
		if (match[1]) links.add(match[1].trim());
	}
	return Array.from(links);
}

/**
 * Format an OKF story note in markdown with YAML frontmatter and Obsidian wikilinks.
 */
export function formatStoryNote(story: OKFStoryNote): string {
	const tags = story.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
	const topicsYaml = story.topics.map((t) => `  - ${JSON.stringify(t)}`).join('\n');
	const conceptsYaml = story.concepts.map((c) => `  - ${JSON.stringify(c)}`).join('\n');
	const tagsYaml = story.tags.map((t) => `  - ${JSON.stringify(t.replace(/^#/, ''))}`).join('\n');

	const conceptsSection = story.concepts
		.map((c) => {
			const cleanName = c.replace(/^\[\[/, '').replace(/\]\]$/, '');
			const desc = story.conceptsDetail?.[cleanName] ?? `Key domain concept referenced in discussion.`;
			return `- [[${cleanName}]]: ${desc}`;
		})
		.join('\n');

	return `---
schema_version: okf/v1
id: ${JSON.stringify(story.id)}
type: story
title: ${JSON.stringify(story.title)}
resource: ${JSON.stringify(story.resource)}
source: hackernews
native_id: ${JSON.stringify(String(story.native_id))}
timestamp: ${JSON.stringify(story.timestamp)}
curator: ${JSON.stringify(story.curator)}
curator_model: ${JSON.stringify(story.curator_model)}
significance_score: ${story.significance_score}
topics:
${topicsYaml}
concepts:
${conceptsYaml}
tags:
${tagsYaml}
---

# ${story.title}

> **Curator Assessment**: ${story.curatorNotes}
> Tags: ${tags}

## Summary
${story.summary}

## Technical Significance & Analysis
${story.significance}

## Knowledge Graph & Linked Concepts
${conceptsSection}

## References & Discussion
- **Original Source**: [${story.resource}](${story.resource})
${story.discussionUrl ? `- **Hacker News**: [${story.discussionUrl}](${story.discussionUrl})` : ''}
${story.by ? `- **Submitted By**: \`${story.by}\`` : ''}
${story.score !== undefined ? `- **HN Score**: ${story.score} points` : ''}
${story.commentsCount !== undefined ? `- **Comments**: ${story.commentsCount}` : ''}
- **Curated By**: ${story.curator} (\`${story.curator_model}\`) on ${story.timestamp}
`;
}

/**
 * Format a concept note in OKF format for Obsidian knowledge graph.
 */
export function formatConceptNote(concept: OKFConceptNote): string {
	const tags = concept.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
	const tagsYaml = concept.tags.map((t) => `  - ${JSON.stringify(t.replace(/^#/, ''))}`).join('\n');

	const storiesList = concept.relatedStories
		.map((s) => `- [[${s.id}|${s.title}]]`)
		.join('\n');

	const relatedConceptsList = (concept.relatedConcepts ?? [])
		.map((c) => `- [[${c}]]`)
		.join('\n');

	return `---
schema_version: okf/v1
id: ${JSON.stringify(concept.id)}
type: concept
title: ${JSON.stringify(concept.title)}
first_observed: ${JSON.stringify(concept.first_observed)}
last_updated: ${JSON.stringify(concept.last_updated)}
curator: ${JSON.stringify(concept.curator)}
tags:
${tagsYaml}
---

# Concept: ${concept.title}

${tags}

## Definition & Overview
${concept.description}

## Referencing Stories
${storiesList || '- *No stories referencing this concept yet.*'}

${relatedConceptsList ? `## Related Concepts\n${relatedConceptsList}\n` : ''}
## Provenance
- First cataloged: ${concept.first_observed}
- Last updated: ${concept.last_updated}
- Curator: ${concept.curator}
`;
}

/**
 * Format the Map of Content (index.md) for the Obsidian vault.
 */
export function formatIndexMOC(stories: OKFStoryNote[], concepts: OKFConceptNote[]): string {
	const now = new Date().toISOString();

	const sortedStories = [...stories].sort(
		(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
	);

	const storiesList = sortedStories
		.map(
			(s) =>
				`- **${s.timestamp.slice(0, 10)}** — [[${s.id}|${s.title}]] ` +
				`(Score: ${Math.round(s.significance_score * 100)}%, Concepts: ${s.concepts.join(', ')})`,
		)
		.join('\n');

	const conceptsList = [...concepts]
		.sort((a, b) => a.title.localeCompare(b.title))
		.map((c) => `- [[${c.title}]] (${c.relatedStories.length} stories)`)
		.join('\n');

	return `---
schema_version: okf/v1
id: library-moc
type: index
title: "Autonomous Knowledge Library — Vault Index"
last_updated: ${JSON.stringify(now)}
total_stories: ${stories.length}
total_concepts: ${concepts.length}
---

# 📚 Autonomous Knowledge Library

Welcome to the **Autonomous Knowledge Library** vault.
Maintained autonomously by AI Librarians and Curators using **Google Open Knowledge Format (OKF)**.

> **Obsidian Tip**: Press \`Ctrl/Cmd + G\` to open the **Graph View** to explore links between stories and concepts!

## 📖 Curated Stories (${stories.length})
${storiesList || '- *No stories curated yet.*'}

## 🧠 Knowledge Graph Concepts (${concepts.length})
${conceptsList || '- *No concepts registered yet.*'}

## 🔍 System Information
- **Standard**: Google Open Knowledge Format (OKF) v1
- **Curator Model**: \`meta/muse-spark-1.3-contributor\`
- **Vault Status**: Synchronized
- **Last Index Build**: ${now}
`;
}

/**
 * Format an append-only log entry for log.md.
 */
export function formatLogEntry(entry: OKFLogEntry): string {
	const date = entry.timestamp.slice(0, 10);
	const time = entry.timestamp.slice(11, 19);
	return `- [${date} ${time}Z] **${entry.action.toUpperCase()}**: [[${entry.storyId}|${entry.title}]] by ${entry.curator}${entry.details ? ` — ${entry.details}` : ''}\n`;
}
