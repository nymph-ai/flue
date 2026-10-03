/**
 * SearchIndex for progressive capability discovery.
 *
 * Implements deterministic search and relevance ranking over canonical capabilities.
 *
 * INVARIANT: Search is a strictly pure read operation over the CapabilityRegistry.
 * It NEVER mutates tools/list or active capabilities as a side effect.
 *
 * Reference: docs/mcp-capability-projection.md § 7
 */

import type { Capability, CapabilityKind, SearchResultHit } from './types.ts';
import type { CapabilityRegistry } from './registry.ts';

export class SearchIndex {
	constructor(private readonly registry: CapabilityRegistry) {}

	/**
	 * Perform search query across all registered capabilities.
	 * Returns ranked search hits with resource links.
	 */
	search(params: {
		query: string;
		kinds?: CapabilityKind[];
		category?: string;
		limit?: number;
	}): SearchResultHit[] {
		const rawQuery = (params.query ?? '').trim().toLowerCase();
		const queryTokens = rawQuery.split(/[\s_\-.:/]+/).filter((t) => t.length > 0);
		const limit = Math.max(1, Math.min(params.limit ?? 20, 100));

		const capabilities = this.registry.list({
			category: params.category,
		});

		const hits: SearchResultHit[] = [];

		for (const cap of capabilities) {
			if (params.kinds && params.kinds.length > 0 && !params.kinds.includes(cap.kind)) {
				continue;
			}

			const score = this.calculateScore(cap, rawQuery, queryTokens);
			if (score > 0 || rawQuery.length === 0) {
				const resourceUris = cap.resources?.map((r) => r.uri) ?? [];
				const skillUris = cap.skills?.map((s) => s.uri) ?? [];

				hits.push({
					id: cap.id,
					kind: cap.kind,
					title: cap.title,
					description: cap.description,
					category: cap.category,
					score: Number(score.toFixed(3)),
					links: {
						capabilityUri: `capability://${cap.id}`,
						resourceUris: resourceUris.length > 0 ? resourceUris : undefined,
						skillUris: skillUris.length > 0 ? skillUris : undefined,
						uiUri: cap.ui?.viewUri,
					},
				});
			}
		}

		// Sort by score descending, then by stable ID ascending
		hits.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.id.localeCompare(b.id);
		});

		return hits.slice(0, limit);
	}

	private calculateScore(cap: Capability, rawQuery: string, tokens: string[]): number {
		if (tokens.length === 0) {
			return cap.searchMetadata?.rankingWeight ?? 1.0;
		}

		let score = 0;
		const idLower = cap.id.toLowerCase();
		const titleLower = cap.title.toLowerCase();
		const descLower = cap.description.toLowerCase();
		const categoryLower = (cap.category ?? '').toLowerCase();
		const tagsLower = (cap.searchMetadata?.tags ?? []).map((t) => t.toLowerCase());
		const keywordsLower = (cap.searchMetadata?.keywords ?? []).map((k) => k.toLowerCase());

		// 1. Exact ID match (highest priority)
		if (idLower === rawQuery) {
			score += 10.0;
		} else if (idLower.includes(rawQuery)) {
			score += 5.0;
		}

		// 2. Exact Title match
		if (titleLower === rawQuery) {
			score += 8.0;
		} else if (titleLower.includes(rawQuery)) {
			score += 4.0;
		}

		// 3. Category match
		if (categoryLower === rawQuery) {
			score += 4.0;
		} else if (categoryLower.includes(rawQuery)) {
			score += 2.0;
		}

		// 4. Token matches
		for (const token of tokens) {
			if (idLower.includes(token)) score += 2.0;
			if (titleLower.includes(token)) score += 1.5;
			if (tagsLower.some((t) => t === token || t.includes(token))) score += 2.0;
			if (keywordsLower.some((k) => k === token || k.includes(token))) score += 2.0;
			if (descLower.includes(token)) score += 0.8;
		}

		// Apply ranking multiplier
		const weight = cap.searchMetadata?.rankingWeight ?? 1.0;
		return score * weight;
	}
}
