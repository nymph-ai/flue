'use agent';
import { useModel, useTool } from '@flue/runtime';
import { libraryModel, liveModel } from '../model.ts';
import { getOrCreateVault } from '../wiki/routes.ts';
import type { OKFStoryNote } from '../wiki/types.ts';

export { cloudflare } from '../qualification/hooks.ts';

/** The world stream the sensory ingest feeds with Hacker News items. */
export const WORLD_STREAM = 'v1/stream/world/hn/items';

/** The library recommendations stream where curated stories are broadcast. */
export const LIBRARY_RECOMMENDATIONS_STREAM = 'v1/stream/library/curator/recommendations';

export function Curator() {
	useModel(libraryModel());

	useTool({
		name: 'curate_story',
		description:
			'Curate a technical story into the autonomous knowledge library vault in Google Open Knowledge Format (OKF).',
		input: {
			type: 'object',
			properties: {
				native_id: { type: 'string', description: 'Hacker News item ID (e.g. "49930412")' },
				title: { type: 'string', description: 'Story title' },
				url: { type: 'string', description: 'Original URL of the article or paper' },
				summary: { type: 'string', description: '2-3 paragraph executive summary of the story' },
				significance: {
					type: 'string',
					description: 'Deep technical significance and implications for distributed/agent systems',
				},
				curatorNotes: { type: 'string', description: 'Short assessment of why this story matters' },
				topics: { type: 'array', items: { type: 'string' }, description: 'Broad topics (e.g. Systems, eBPF)' },
				concepts: {
					type: 'array',
					items: { type: 'string' },
					description: 'Key concepts formatted as Obsidian wikilinks, e.g. ["[[bpf_fault]]", "[[userfaultfd]]"]',
				},
				conceptsDetail: {
					type: 'object',
					description: 'Map from concept name to 1-sentence description',
				},
				tags: {
					type: 'array',
					items: { type: 'string' },
					description: 'Obsidian tags (e.g. ["#ebpf", "#kernel", "#memory"])',
				},
				significance_score: {
					type: 'number',
					description: 'Relevance score between 0.0 and 1.0',
				},
				by: { type: 'string', description: 'Submitter handle' },
				score: { type: 'number', description: 'Community score' },
			},
			required: ['native_id', 'title', 'url', 'summary', 'significance', 'curatorNotes', 'topics', 'concepts'],
		},
		run: async ({
			native_id,
			title,
			url,
			summary,
			significance,
			curatorNotes,
			topics,
			concepts,
			conceptsDetail = {},
			tags = [],
			significance_score = 0.9,
			by,
			score,
		}: {
			native_id: string;
			title: string;
			url: string;
			summary: string;
			significance: string;
			curatorNotes: string;
			topics: string[];
			concepts: string[];
			conceptsDetail?: Record<string, string>;
			tags?: string[];
			significance_score?: number;
			by?: string;
			score?: number;
		}) => {
			const vault = getOrCreateVault();
			const now = new Date().toISOString();
			const storyId = `hn-${native_id}`;

			const story: OKFStoryNote = {
				schema_version: 'okf/v1',
				id: storyId,
				type: 'story',
				title,
				resource: url,
				source: 'hackernews',
				native_id,
				timestamp: now,
				curator: 'curator',
				curator_model: liveModel(),
				significance_score,
				topics,
				concepts,
				conceptsDetail,
				tags: tags.length > 0 ? tags : topics.map((t) => `#${t.toLowerCase().replace(/\s+/g, '-')}`),
				summary,
				significance,
				curatorNotes,
				discussionUrl: `https://news.ycombinator.com/item?id=${native_id}`,
				by,
				score,
			};

			const path = await vault.saveStoryNote(story);
			return {
				status: 'curated',
				path,
				storyId,
				title,
				conceptsAdded: concepts.length,
				vaultIndexUpdated: true,
			};
		},
	});

	return [
		'You are the Curator of an autonomous knowledge library.',
		'You watch the world for interesting developments, synthesize knowledge notes in Google Open Knowledge Format (OKF), and maintain the library wiki.',
		`When asked to start watching, call observe with key "hn", stream "${WORLD_STREAM}" and wake true.`,
		'Observed items arrive in your history on their own.',
		'When you find a high-value technical story, call curate_story to synthesize it into an OKF note with [[wikilinks]] in the vault.',
	].join('\n');
}
Curator.agentName = 'curator';
