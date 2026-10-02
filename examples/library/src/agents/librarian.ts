'use agent';
import { useModel, useTool } from '@flue/runtime';
import { libraryModel } from '../model.ts';
import { getOrCreateVault } from '../wiki/routes.ts';
import type { OKFConceptNote } from '../wiki/types.ts';

export { cloudflare } from '../qualification/hooks.ts';

export function Librarian() {
	useModel(libraryModel());

	useTool({
		name: 'search_vault',
		description: 'Search for stories and concepts in the autonomous knowledge library vault.',
		input: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search term or topic' },
				type: { type: 'string', enum: ['all', 'stories', 'concepts'], description: 'Filter by note type' },
			},
			required: ['query'],
		},
		run: async ({ query, type = 'all' }: { query: string; type?: string }) => {
			const vault = getOrCreateVault();
			const allPaths = await vault.listNotes();
			const matches: Array<{ path: string; excerpt: string }> = [];

			const targetPaths = allPaths.filter((p) => {
				if (type === 'stories') return p.startsWith('stories/');
				if (type === 'concepts') return p.startsWith('concepts/');
				return true;
			});

			for (const path of targetPaths) {
				const content = await vault.getNote(path);
				if (content && content.toLowerCase().includes(query.toLowerCase())) {
					const idx = content.toLowerCase().indexOf(query.toLowerCase());
					const start = Math.max(0, idx - 60);
					const end = Math.min(content.length, idx + 100);
					matches.push({
						path,
						excerpt: `...${content.slice(start, end).replace(/\n+/g, ' ')}...`,
					});
				}
			}

			return { query, totalMatches: matches.length, matches: matches.slice(0, 10) };
		},
	});

	useTool({
		name: 'catalog_concept',
		description: 'Catalog or enrich an OKF concept note in the knowledge graph.',
		input: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Concept name (e.g. "bpf_fault")' },
				description: { type: 'string', description: 'Detailed definition and architectural significance' },
				tags: { type: 'array', items: { type: 'string' }, description: 'Obsidian tags' },
				relatedConcepts: { type: 'array', items: { type: 'string' }, description: 'Related concept titles' },
			},
			required: ['title', 'description'],
		},
		run: async ({
			title,
			description,
			tags = [],
			relatedConcepts = [],
		}: {
			title: string;
			description: string;
			tags?: string[];
			relatedConcepts?: string[];
		}) => {
			const vault = getOrCreateVault();
			const now = new Date().toISOString();
			const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

			const existingContent = await vault.getNote(`concepts/${slug}.md`);
			const note: OKFConceptNote = {
				schema_version: 'okf/v1',
				id: slug,
				type: 'concept',
				title,
				first_observed: now,
				last_updated: now,
				curator: 'librarian',
				tags,
				description,
				relatedStories: [],
				relatedConcepts,
			};

			const path = await vault.saveConceptNote(note);
			await vault.rebuildIndex();
			return { status: existingContent ? 'updated' : 'cataloged', path, title };
		},
	});

	useTool({
		name: 'rebuild_index',
		description: 'Rebuild the central index Map of Content (index.md) and update backlinks.',
		input: { type: 'object', properties: {} },
		run: async () => {
			const vault = getOrCreateVault();
			const markdown = await vault.rebuildIndex();
			return { status: 'rebuilt', length: markdown.length };
		},
	});

	return [
		'You are a Librarian of an autonomous knowledge library.',
		'You maintain the Obsidian knowledge graph, catalog concepts, update indexes, verify backlinks, and organize the vault.',
		'Use catalog_concept to record foundational concepts with [[wikilinks]].',
		'Use search_vault to find related notes before adding new ones.',
	].join('\n');
}
Librarian.agentName = 'librarian';
