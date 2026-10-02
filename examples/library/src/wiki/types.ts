/**
 * Types for Google Open Knowledge Format (OKF) and Obsidian Knowledge Base.
 */

export interface OKFStoryFrontmatter {
	schema_version: 'okf/v1';
	id: string; // e.g. "hn-49930412"
	type: 'story' | 'concept' | 'synthesis';
	title: string;
	resource: string; // URL to original content/paper
	source: 'hackernews';
	native_id: string | number;
	timestamp: string; // ISO-8601
	curator: string; // Agent name or ID
	curator_model: string; // e.g. "meta/muse-spark-1.3-contributor"
	significance_score: number; // 0.0 - 1.0
	topics: string[];
	concepts: string[]; // List of [[Concept]] wikilinks
	tags: string[]; // Obsidian tags (e.g. ["#systems", "#ebpf"])
}

export interface OKFStoryNote extends OKFStoryFrontmatter {
	summary: string;
	significance: string;
	curatorNotes: string;
	conceptsDetail?: Record<string, string>; // concept name -> 1-2 sentence description
	discussionUrl?: string;
	by?: string;
	score?: number;
	commentsCount?: number;
}

export interface OKFConceptFrontmatter {
	schema_version: 'okf/v1';
	id: string; // concept slug, e.g. "bpf_fault"
	type: 'concept';
	title: string;
	first_observed: string;
	last_updated: string;
	curator: string;
	tags: string[];
}

export interface OKFConceptNote extends OKFConceptFrontmatter {
	description: string;
	relatedStories: Array<{ id: string; title: string }>;
	relatedConcepts?: string[];
}

export interface OKFLogEntry {
	timestamp: string;
	action: 'curated' | 'indexed' | 'cross_referenced' | 'updated';
	storyId: string;
	title: string;
	curator: string;
	details?: string;
}

export interface VaultFile {
	path: string;
	content: string;
	sha256?: string;
	size: number;
	lastModified: string;
}

export interface VaultManifest {
	vaultName: string;
	standard: 'Google Open Knowledge Format (OKF)';
	version: '1.0.0';
	generatedAt: string;
	totalStories: number;
	totalConcepts: number;
	totalFiles: number;
	files: Array<{
		path: string;
		type: 'story' | 'concept' | 'index' | 'log';
		title: string;
		size: number;
		lastModified: string;
	}>;
}

export interface ArtifactsTokenResult {
	plaintext: string;
	expiresAt: string;
}

export interface ArtifactsRepoHandle {
	name?: string;
	url?: string;
	httpUrl?: string;
	createToken(scope: 'read' | 'write', ttlSeconds?: number): Promise<ArtifactsTokenResult>;
}

export interface ArtifactsBinding {
	get(name: string): Promise<ArtifactsRepoHandle | null>;
	create(name: string, options?: { description?: string }): Promise<ArtifactsRepoHandle>;
	list?(): Promise<Array<{ name: string }>>;
}

export interface GitSyncInfo {
	backend: 'cloudflare-artifacts';
	repository: string;
	branch: string;
	cloneUrl?: string;
	endpoints: {
		token: string;
		manifest: string;
	};
	instructions: {
		obsidianGit: string[];
		gitCli: string[];
	};
}

