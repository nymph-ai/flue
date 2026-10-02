'use agent';
import * as v from 'valibot';
import { defineTool, useModel, useTool } from '@flue/runtime';
import { libraryModel, liveModel } from './model.ts';
import { getOrCreateVault } from './wiki/routes.ts';
import type { OKFConceptNote, OKFStoryNote } from './wiki/types.ts';

export { cloudflare } from './qualification/hooks.ts';

/** The world stream the sensory ingest feeds with Hacker News items. */
export const WORLD_STREAM = 'v1/stream/world/hn/items';

/** The recommendations stream where curated stories are broadcast. */
export const RECOMMENDATIONS_STREAM = 'v1/stream/library/curator/recommendations';

/**
 * Tool: Curate a technical story into the knowledge vault in Google Open Knowledge Format (OKF).
 * Automatically updates concept cards, audit log, and the central index.md (Map of Content).
 */
export const curateStory = defineTool({
	name: 'curate_story',
	description:
		'Curate a technical story into the knowledge vault in Google Open Knowledge Format (OKF). Automatically creates concept notes and updates the vault index.',
	input: v.object({
		native_id: v.string(),
		title: v.string(),
		url: v.string(),
		summary: v.string(),
		significance: v.string(),
		curatorNotes: v.string(),
		topics: v.array(v.string()),
		concepts: v.array(v.string()),
		tags: v.optional(v.array(v.string())),
		significance_score: v.optional(v.number()),
		by: v.optional(v.string()),
		score: v.optional(v.number()),
	}),
	run: async ({ data }) => {
		const vault = getOrCreateVault();
		const now = new Date().toISOString();
		const storyId = `hn-${data.native_id}`;

		const story: OKFStoryNote = {
			schema_version: 'okf/v1',
			id: storyId,
			type: 'story',
			title: data.title,
			resource: data.url,
			source: 'hackernews',
			native_id: data.native_id,
			timestamp: now,
			curator: 'curator',
			curator_model: liveModel(),
			significance_score: data.significance_score ?? 0.9,
			topics: data.topics,
			concepts: data.concepts,
			tags:
				data.tags && data.tags.length > 0
					? data.tags
					: data.topics.map((t) => `#${t.toLowerCase().replace(/\s+/g, '-')}`),
			summary: data.summary,
			significance: data.significance,
			curatorNotes: data.curatorNotes,
			discussionUrl: `https://news.ycombinator.com/item?id=${data.native_id}`,
			by: data.by,
			score: data.score,
		};

		const path = await vault.saveStoryNote(story);
		return {
			output: {
				status: 'curated',
				path,
				storyId,
				title: data.title,
				conceptsAdded: data.concepts.length,
				vaultIndexUpdated: true,
			},
		};
	},
});

/**
 * Tool: Search for existing stories and concepts in the knowledge vault.
 */
export const searchVault = defineTool({
	name: 'search_vault',
	description: 'Search for existing stories and concepts in the knowledge vault to check prior context or avoid duplicates.',
	input: v.object({
		query: v.string(),
		type: v.optional(v.union([v.literal('all'), v.literal('stories'), v.literal('concepts')])),
	}),
	run: async ({ data }) => {
		const vault = getOrCreateVault();
		const allPaths = await vault.listNotes();
		const matches: Array<{ path: string; excerpt: string }> = [];

		const targetPaths = allPaths.filter((p) => {
			if (data.type === 'stories') return p.startsWith('stories/');
			if (data.type === 'concepts') return p.startsWith('concepts/');
			return true;
		});

		for (const path of targetPaths) {
			const content = await vault.getNote(path);
			if (content && content.toLowerCase().includes(data.query.toLowerCase())) {
				const idx = content.toLowerCase().indexOf(data.query.toLowerCase());
				const start = Math.max(0, idx - 60);
				const end = Math.min(content.length, idx + 100);
				matches.push({
					path,
					excerpt: `...${content.slice(start, end).replace(/\n+/g, ' ')}...`,
				});
			}
		}

		return {
			output: {
				query: data.query,
				totalMatches: matches.length,
				matches: matches.slice(0, 10),
			},
		};
	},
});

/**
 * Tool: Rebuild the central index Map of Content (index.md) and update backlinks.
 */
export const rebuildIndex = defineTool({
	name: 'rebuild_index',
	description: 'Rebuild the central index Map of Content (index.md) and refresh vault statistics.',
	run: async () => {
		const vault = getOrCreateVault();
		const markdown = await vault.rebuildIndex();
		return {
			output: {
				status: 'rebuilt',
				indexLength: markdown.length,
				timestamp: new Date().toISOString(),
			},
		};
	},
});

/**
 * The single Muse Spark Pi agent.
 * Handles story intake, evaluation, concept extraction, and Obsidian vault maintenance.
 */
export function Curator() {
	useModel(libraryModel());
	useTool(curateStory);
	useTool(searchVault);
	useTool(rebuildIndex);

	return [
		'You are an autonomous knowledge curation agent running Muse Spark on Pi.',
		'You monitor incoming Hacker News stream events and maintain an Obsidian-compatible knowledge vault in Google Open Knowledge Format (OKF).',
		`When asked to start watching, call observe with key "hn", stream "${WORLD_STREAM}" and wake true.`,
		'Observed items arrive in your history automatically.',
		'When an item arrives, evaluate its technical significance. You may use search_vault to check existing notes or concepts.',
		'When you find a high-value technical story, call curate_story to synthesize it into an OKF note with [[wikilinks]] in the vault.',
	].join('\n');
}
Curator.agentName = 'curator';

/** Alias */
export const Agent = Curator;
