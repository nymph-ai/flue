/**
 * Storage layer for the Autonomous Knowledge Library Obsidian vault.
 * Supports Cloudflare R2 object storage binding with zero-configuration fallback.
 */
import { formatConceptNote, formatIndexMOC, formatLogEntry, formatStoryNote, slugify } from './okf.ts';
import type { OKFConceptNote, OKFLogEntry, OKFStoryNote, VaultManifest } from './types.ts';

export interface R2BucketLike {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(
		key: string,
		value: string | Uint8Array | ReadableStream,
		options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
	): Promise<unknown>;
	list(options?: { prefix?: string; limit?: number }): Promise<{
		objects: Array<{ key: string; size: number; uploaded: Date }>;
	}>;
	delete(key: string): Promise<void>;
}

export class LibraryVault {
	private readonly r2?: R2BucketLike;
	private readonly memoryStore = new Map<string, { content: string; modified: Date }>();
	private readonly stories = new Map<string, OKFStoryNote>();
	private readonly concepts = new Map<string, OKFConceptNote>();
	private logContent = '# Curator Activity Log\n\n';

	constructor(r2Bucket?: R2BucketLike) {
		this.r2 = r2Bucket;
	}

	/**
	 * Save an OKF story note, updating the concept cross-references and log.
	 */
	async saveStoryNote(story: OKFStoryNote): Promise<string> {
		this.stories.set(story.id, story);
		const markdown = formatStoryNote(story);
		const path = `stories/${story.id}.md`;

		await this.putFile(path, markdown, 'text/markdown');

		// Automatically register or update concepts referenced in the story
		for (const conceptLink of story.concepts) {
			const conceptTitle = conceptLink.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
			const slug = slugify(conceptTitle);
			const existing = this.concepts.get(slug);

			const related = existing?.relatedStories ?? [];
			if (!related.some((r) => r.id === story.id)) {
				related.push({ id: story.id, title: story.title });
			}

			const conceptNote: OKFConceptNote = {
				schema_version: 'okf/v1',
				id: slug,
				type: 'concept',
				title: conceptTitle,
				first_observed: existing?.first_observed ?? story.timestamp,
				last_updated: story.timestamp,
				curator: story.curator,
				tags: Array.from(new Set([...(existing?.tags ?? []), ...story.tags])),
				description:
					story.conceptsDetail?.[conceptTitle] ??
					existing?.description ??
					`Core domain concept extracted from curated literature.`,
				relatedStories: related,
			};

			await this.saveConceptNote(conceptNote);
		}

		// Append to audit log
		await this.appendLog({
			timestamp: story.timestamp,
			action: 'curated',
			storyId: story.id,
			title: story.title,
			curator: story.curator,
			details: `Topics: ${story.topics.join(', ')} | Score: ${Math.round(story.significance_score * 100)}%`,
		});

		// Rebuild Map of Content (index.md)
		await this.rebuildIndex();

		return path;
	}

	/**
	 * Save an OKF concept note.
	 */
	async saveConceptNote(concept: OKFConceptNote): Promise<string> {
		this.concepts.set(concept.id, concept);
		const markdown = formatConceptNote(concept);
		const path = `concepts/${concept.id}.md`;
		await this.putFile(path, markdown, 'text/markdown');
		return path;
	}

	/**
	 * Retrieve a note by relative vault path.
	 */
	async getNote(path: string): Promise<string | null> {
		const cleanPath = path.replace(/^\/+/, '');
		if (this.r2) {
			try {
				const obj = await this.r2.get(cleanPath);
				if (obj) return await obj.text();
			} catch {
				// Fall back to memoryStore
			}
		}
		const mem = this.memoryStore.get(cleanPath);
		return mem ? mem.content : null;
	}

	/**
	 * List all note paths with an optional prefix (e.g. "stories/", "concepts/").
	 */
	async listNotes(prefix = ''): Promise<string[]> {
		const result = new Set<string>();
		if (this.r2) {
			try {
				const listed = await this.r2.list({ prefix });
				for (const o of listed.objects) result.add(o.key);
			} catch {
				// Fall back to memoryStore
			}
		}
		for (const key of this.memoryStore.keys()) {
			if (key.startsWith(prefix)) result.add(key);
		}
		return Array.from(result).sort();
	}

	/**
	 * Append an entry to the audit log (log.md).
	 */
	async appendLog(entry: OKFLogEntry): Promise<void> {
		const formatted = formatLogEntry(entry);
		this.logContent += formatted;
		await this.putFile('log.md', this.logContent, 'text/markdown');
	}

	/**
	 * Rebuild the central index Map of Content (index.md).
	 */
	async rebuildIndex(): Promise<string> {
		const storiesList = Array.from(this.stories.values());
		const conceptsList = Array.from(this.concepts.values());
		const markdown = formatIndexMOC(storiesList, conceptsList);
		await this.putFile('index.md', markdown, 'text/markdown');
		return markdown;
	}

	/**
	 * Generate a complete JSON manifest of the vault for sync tools.
	 */
	async getManifest(): Promise<VaultManifest> {
		const files: VaultManifest['files'] = [];

		for (const [id, story] of this.stories.entries()) {
			const path = `stories/${id}.md`;
			const content = (await this.getNote(path)) ?? '';
			files.push({
				path,
				type: 'story',
				title: story.title,
				size: content.length,
				lastModified: story.timestamp,
			});
		}

		for (const [id, concept] of this.concepts.entries()) {
			const path = `concepts/${id}.md`;
			const content = (await this.getNote(path)) ?? '';
			files.push({
				path,
				type: 'concept',
				title: concept.title,
				size: content.length,
				lastModified: concept.last_updated,
			});
		}

		const indexContent = (await this.getNote('index.md')) ?? '';
		files.push({
			path: 'index.md',
			type: 'index',
			title: 'Autonomous Knowledge Library Index',
			size: indexContent.length,
			lastModified: new Date().toISOString(),
		});

		const logContent = (await this.getNote('log.md')) ?? '';
		files.push({
			path: 'log.md',
			type: 'log',
			title: 'Curator & Librarian Activity Log',
			size: logContent.length,
			lastModified: new Date().toISOString(),
		});

		return {
			vaultName: 'Autonomous Knowledge Library',
			standard: 'Google Open Knowledge Format (OKF)',
			version: '1.0.0',
			generatedAt: new Date().toISOString(),
			totalStories: this.stories.size,
			totalConcepts: this.concepts.size,
			totalFiles: files.length,
			files,
		};
	}

	private async putFile(path: string, content: string, contentType: string): Promise<void> {
		this.memoryStore.set(path, { content, modified: new Date() });
		if (this.r2) {
			try {
				await this.r2.put(path, content, {
					httpMetadata: { contentType },
					customMetadata: { updated: new Date().toISOString() },
				});
			} catch {
				// Ignore R2 put errors if bucket is unconfigured
			}
		}
	}
}
