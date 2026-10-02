'use agent';
import * as v from 'valibot';
import { defineTool, useModel, useTool } from '@flue/runtime';
import { libraryModel } from '../model.ts';
import { getOrCreateVault } from '../wiki/routes.ts';
import type { OKFConceptNote } from '../wiki/types.ts';

export { cloudflare } from '../qualification/hooks.ts';

export const searchVault = defineTool({
	name: 'search_vault',
	description: 'Search for stories and concepts in the autonomous knowledge library vault.',
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

export const catalogConcept = defineTool({
	name: 'catalog_concept',
	description: 'Catalog or enrich an OKF concept note in the knowledge graph.',
	input: v.object({
		title: v.string(),
		description: v.string(),
		tags: v.optional(v.array(v.string())),
		relatedConcepts: v.optional(v.array(v.string())),
	}),
	run: async ({ data }) => {
		const vault = getOrCreateVault();
		const now = new Date().toISOString();
		const slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

		const existingContent = await vault.getNote(`concepts/${slug}.md`);
		const note: OKFConceptNote = {
			schema_version: 'okf/v1',
			id: slug,
			type: 'concept',
			title: data.title,
			first_observed: now,
			last_updated: now,
			curator: 'librarian',
			tags: data.tags ?? [],
			description: data.description,
			relatedStories: [],
			relatedConcepts: data.relatedConcepts ?? [],
		};

		const path = await vault.saveConceptNote(note);
		await vault.rebuildIndex();
		return {
			output: {
				status: existingContent ? 'updated' : 'cataloged',
				path,
				title: data.title,
			},
		};
	},
});

export const rebuildIndex = defineTool({
	name: 'rebuild_index',
	description: 'Rebuild the central index Map of Content (index.md) and update backlinks.',
	run: async () => {
		const vault = getOrCreateVault();
		const markdown = await vault.rebuildIndex();
		return {
			output: {
				status: 'rebuilt',
				length: markdown.length,
			},
		};
	},
});

export function Librarian() {
	useModel(libraryModel());
	useTool(searchVault);
	useTool(catalogConcept);
	useTool(rebuildIndex);

	return [
		'You are a Librarian of an autonomous knowledge library.',
		'You maintain the Obsidian knowledge graph, catalog concepts, update indexes, verify backlinks, and organize the vault.',
		'Use catalog_concept to record foundational concepts with [[wikilinks]].',
		'Use search_vault to find related notes before adding new ones.',
	].join('\n');
}
Librarian.agentName = 'librarian';
