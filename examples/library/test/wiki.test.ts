import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
	env: {},
	DurableObject: class {},
}));
import { extractWikilinks, formatConceptNote, formatIndexMOC, formatLogEntry, formatStoryNote, slugify } from '../src/wiki/okf.ts';
import { createWikiRouter } from '../src/wiki/routes.ts';
import { LibraryVault } from '../src/wiki/storage.ts';
import type { OKFConceptNote, OKFStoryNote } from '../src/wiki/types.ts';
import { curateStory, rebuildIndex, searchVault } from '../src/agent.ts';

describe('Google Open Knowledge Format (OKF) & Obsidian Vault', () => {
	it('formats an OKF story note with frontmatter and wikilinks', () => {
		const story: OKFStoryNote = {
			schema_version: 'okf/v1',
			id: 'hn-49930412',
			type: 'story',
			title: "It's the Kernel's Fault: Custom Page Fault Handling with Bpf_fault",
			resource: 'https://dl.acm.org/doi/10.1145/3830418.3843896',
			source: 'hackernews',
			native_id: '49930412',
			timestamp: '2026-10-02T07:17:09Z',
			curator: 'curator',
			curator_model: 'meta/muse-spark-1.3-contributor',
			significance_score: 0.92,
			topics: ['Systems', 'Linux Kernel', 'eBPF'],
			concepts: ['[[bpf_fault]]', '[[userfaultfd]]', '[[Demand Paging]]'],
			conceptsDetail: {
				bpf_fault: 'Kernel mechanism for in-kernel page fault handlers.',
				userfaultfd: 'Legacy user-space page fault handling mechanism.',
				'Demand Paging': 'Virtual memory paging strategy.',
			},
			tags: ['#systems', '#ebpf', '#kernel'],
			summary: 'Introduces bpf_fault, an eBPF extension enabling user-defined page fault handlers.',
			significance: 'Critical for sub-10ms Firecracker snapshot restoration.',
			curatorNotes: 'High-impact kernel primitive.',
			by: 'theanonymousone',
			score: 142,
			commentsCount: 38,
		};

		const markdown = formatStoryNote(story);
		expect(markdown).toContain('schema_version: okf/v1');
		expect(markdown).toContain('id: "hn-49930412"');
		expect(markdown).toContain('curator_model: "meta/muse-spark-1.3-contributor"');
		expect(markdown).toContain('[[bpf_fault]]');
		expect(markdown).toContain('[[userfaultfd]]');
		expect(markdown).toContain('[[Demand Paging]]');
		expect(markdown).toContain('## Summary');
		expect(markdown).toContain('## Technical Significance & Analysis');
		expect(markdown).toContain('## Knowledge Graph & Linked Concepts');

		const links = extractWikilinks(markdown);
		expect(links).toContain('bpf_fault');
		expect(links).toContain('userfaultfd');
		expect(links).toContain('Demand Paging');
	});

	it('formats concept notes and Map of Content (index.md)', () => {
		const concept: OKFConceptNote = {
			schema_version: 'okf/v1',
			id: 'bpf-fault',
			type: 'concept',
			title: 'bpf_fault',
			first_observed: '2026-10-02T07:17:09Z',
			last_updated: '2026-10-02T07:17:09Z',
			curator: 'curator',
			tags: ['#ebpf', '#kernel'],
			description: 'In-kernel page fault handler using eBPF.',
			relatedStories: [{ id: 'hn-49930412', title: "It's the Kernel's Fault" }],
			relatedConcepts: ['userfaultfd', 'Demand Paging'],
		};

		const note = formatConceptNote(concept);
		expect(note).toContain('type: concept');
		expect(note).toContain('title: "bpf_fault"');
		expect(note).toContain('[[hn-49930412|It\'s the Kernel\'s Fault]]');
		expect(note).toContain('[[userfaultfd]]');

		const moc = formatIndexMOC([], [concept]);
		expect(moc).toContain('Autonomous Knowledge Library — Vault Index');
		expect(moc).toContain('[[bpf_fault]] (1 stories)');
	});

	it('saves notes, generates concepts, and packages vault zip in LibraryVault', async () => {
		const vault = new LibraryVault();

		const story: OKFStoryNote = {
			schema_version: 'okf/v1',
			id: 'hn-49930412',
			type: 'story',
			title: "It's the Kernel's Fault",
			resource: 'https://dl.acm.org/doi/10.1145/3830418.3843896',
			source: 'hackernews',
			native_id: '49930412',
			timestamp: '2026-10-02T07:17:09Z',
			curator: 'curator',
			curator_model: 'meta/muse-spark-1.3-contributor',
			significance_score: 0.95,
			topics: ['Systems'],
			concepts: ['[[bpf_fault]]', '[[userfaultfd]]'],
			tags: ['#systems'],
			summary: 'Summary text',
			significance: 'Significance text',
			curatorNotes: 'Curator assessment',
		};

		const savedPath = await vault.saveStoryNote(story);
		expect(savedPath).toBe('stories/hn-49930412.md');

		// Check story was stored
		const storyContent = await vault.getNote('stories/hn-49930412.md');
		expect(storyContent).toContain("It's the Kernel's Fault");

		// Check concept was automatically generated
		const conceptContent = await vault.getNote('concepts/bpf-fault.md');
		expect(conceptContent).not.toBeNull();
		expect(conceptContent).toContain('title: "bpf_fault"');

		// Check index.md exists
		const index = await vault.getNote('index.md');
		expect(index).toContain('hn-49930412');

		// Check log.md exists
		const log = await vault.getNote('log.md');
		expect(log).toContain('CURATED');
		expect(log).toContain('hn-49930412');

		// Check manifest
		const manifest = await vault.getManifest();
		expect(manifest.vaultName).toBe('Autonomous Knowledge Library');
		expect(manifest.totalStories).toBe(1);
		expect(manifest.totalConcepts).toBe(2);

		// Check exportVaultZip generates a valid ZIP archive (signature 0x04034b50)
		const zipBytes = await vault.exportVaultZip();
		expect(zipBytes.byteLength).toBeGreaterThan(100);
		// Check PK.. magic header
		expect(zipBytes[0]).toBe(0x50); // 'P'
		expect(zipBytes[1]).toBe(0x4b); // 'K'
		expect(zipBytes[2]).toBe(0x03);
		expect(zipBytes[3]).toBe(0x04);
	});

	it('routes serve vault index, notes, manifest, and vault.zip', async () => {
		const vault = new LibraryVault();
		const router = createWikiRouter(() => vault);

		await vault.saveStoryNote({
			schema_version: 'okf/v1',
			id: 'hn-12345',
			type: 'story',
			title: 'Test Story',
			resource: 'https://example.com',
			source: 'hackernews',
			native_id: '12345',
			timestamp: '2026-10-02T08:00:00Z',
			curator: 'curator',
			curator_model: 'meta/muse-spark-1.3-contributor',
			significance_score: 0.8,
			topics: ['AI'],
			concepts: ['[[LLM]]'],
			tags: ['#ai'],
			summary: 'Summary',
			significance: 'Significance',
			curatorNotes: 'Notes',
		});

		// GET /index.md
		const resIndex = await router.request('/index.md');
		expect(resIndex.status).toBe(200);
		const indexText = await resIndex.text();
		expect(indexText).toContain('Autonomous Knowledge Library');

		// GET /stories/hn-12345
		const resStory = await router.request('/stories/hn-12345');
		expect(resStory.status).toBe(200);
		const storyText = await resStory.text();
		expect(storyText).toContain('Test Story');

		// GET /manifest
		const resManifest = await router.request('/manifest');
		expect(resManifest.status).toBe(200);
		const manifestJson = (await resManifest.json()) as { totalStories: number };
		expect(manifestJson.totalStories).toBe(1);

		// GET /vault.zip
		const resZip = await router.request('/vault.zip');
		expect(resZip.status).toBe(200);
		expect(resZip.headers.get('content-type')).toBe('application/zip');
		const zipBuffer = await resZip.arrayBuffer();
		expect(zipBuffer.byteLength).toBeGreaterThan(100);
	});

	it('executes e2e curation workflow: ingest story -> agent tool -> vault persistence -> wiki API & zip', async () => {
		// 1. Ingest: Hacker News sensory item
		const sensoryObservation = {
			id: 'hackernews:story:49930412',
			native_id: '49930412',
			title: "It's the Kernel's Fault: Custom Page Fault Handling with Bpf_fault",
			url: 'https://dl.acm.org/doi/10.1145/3830418.3843896',
			by: 'theanonymousone',
			score: 142,
		};

		// 2. Curator agent invokes curate_story tool
		const curationResult = (await curateStory.run({
			data: {
				native_id: sensoryObservation.native_id,
				title: sensoryObservation.title,
				url: sensoryObservation.url,
				summary: 'Introduces bpf_fault, an eBPF extension enabling user-defined in-kernel page fault handlers.',
				significance: 'Critical for sub-10ms Firecracker snapshot restoration without userfaultfd IPC overhead.',
				curatorNotes: 'High-impact kernel primitive for hypervisors and agent runtimes.',
				topics: ['Systems', 'Linux Kernel', 'eBPF'],
				concepts: ['[[bpf_fault]]', '[[userfaultfd]]', '[[Demand Paging]]'],
				significance_score: 0.94,
				by: sensoryObservation.by,
				score: sensoryObservation.score,
			},
		} as never)) as { output: { status: string; storyId: string; conceptsAdded: number; path: string } };

		expect(curationResult.output.status).toBe('curated');
		expect(curationResult.output.storyId).toBe('hn-49930412');
		expect(curationResult.output.conceptsAdded).toBe(3);

		// 3. Curator agent searches vault
		const searchResult = (await searchVault.run({
			data: { query: 'bpf_fault', type: 'all' },
		} as never)) as { output: { totalMatches: number } };
		expect(searchResult.output.totalMatches).toBeGreaterThan(0);

		// 4. Curator agent rebuilds index
		const rebuildResult = (await rebuildIndex.run({} as never)) as { output: { status: string } };
		expect(rebuildResult.output.status).toBe('rebuilt');

		// 5. Query Hono wiki router
		const router = createWikiRouter();
		const resIndex = await router.request('/index.md');
		expect(resIndex.status).toBe(200);
		const indexContent = await resIndex.text();
		expect(indexContent).toContain("It's the Kernel's Fault");
		expect(indexContent).toContain('[[bpf_fault]]');

		const resConcept = await router.request('/concepts/bpf-fault');
		expect(resConcept.status).toBe(200);
		const conceptContent = await resConcept.text();
		expect(conceptContent).toContain('bpf_fault');
		expect(conceptContent).toContain("It's the Kernel's Fault");

		const resZip = await router.request('/vault.zip');
		expect(resZip.status).toBe(200);
		const zipBuffer = await resZip.arrayBuffer();
		expect(zipBuffer.byteLength).toBeGreaterThan(500);
	});
});
