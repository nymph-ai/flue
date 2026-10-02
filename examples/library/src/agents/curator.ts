'use agent';
import * as v from 'valibot';
import { defineTool, useModel, useTool } from '@flue/runtime';
import { libraryModel, liveModel } from '../model.ts';
import { getOrCreateVault } from '../wiki/routes.ts';
import type { OKFStoryNote } from '../wiki/types.ts';

export { cloudflare } from '../qualification/hooks.ts';

/** The world stream the sensory ingest feeds with Hacker News items. */
export const WORLD_STREAM = 'v1/stream/world/hn/items';

/** The library recommendations stream where curated stories are broadcast. */
export const LIBRARY_RECOMMENDATIONS_STREAM = 'v1/stream/library/curator/recommendations';

export const curateStory = defineTool({
	name: 'curate_story',
	description:
		'Curate a technical story into the autonomous knowledge library vault in Google Open Knowledge Format (OKF).',
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

export function Curator() {
	useModel(libraryModel());
	useTool(curateStory);

	return [
		'You are the Curator of an autonomous knowledge library.',
		'You watch the world for interesting developments, synthesize knowledge notes in Google Open Knowledge Format (OKF), and maintain the library wiki.',
		`When asked to start watching, call observe with key "hn", stream "${WORLD_STREAM}" and wake true.`,
		'Observed items arrive in your history on their own.',
		'When you find a high-value technical story, call curate_story to synthesize it into an OKF note with [[wikilinks]] in the vault.',
	].join('\n');
}
Curator.agentName = 'curator';
