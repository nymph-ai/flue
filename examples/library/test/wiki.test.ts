import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
	env: {},
	DurableObject: class {},
}));
import { extractWikilinks, formatConceptNote, formatIndexMOC, formatLogEntry, formatStoryNote, slugify } from '../src/wiki/okf.ts';
import { createMcpRouter } from '../src/mcp/router.ts';
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

	it('saves notes, generates concepts, and manifests in LibraryVault', async () => {
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
	});

	it('routes serve vault index, notes, and manifest', async () => {
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
	});

	it('executes e2e curation workflow: ingest story -> agent tool -> vault persistence -> wiki API', async () => {
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
	});

	it('serves Cloudflare Artifacts Git sync info and tokens for obsidian-git', async () => {
		const router = createWikiRouter();

		// GET /git/info
		const resInfo = await router.request('/git/info');
		expect(resInfo.status).toBe(200);
		const info = (await resInfo.json()) as {
			backend: string;
			repository: string;
			cloneUrl: string;
			instructions: { obsidianGit: string[] };
		};
		expect(info.backend).toBe('cloudflare-artifacts');
		expect(info.repository).toBe('library-vault');
		expect(info.cloneUrl).toContain('library-vault');
		expect(info.instructions.obsidianGit.length).toBeGreaterThan(0);

		// POST /git/token
		const resToken = await router.request('/git/token', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ scope: 'write', ttlSeconds: 3600 }),
		});
		expect(resToken.status).toBe(200);
		const tokenData = (await resToken.json()) as {
			token: string;
			expiresAt: string;
			scope: string;
			repository: string;
		};
		expect(tokenData.token).toBeDefined();
		expect(tokenData.scope).toBe('write');
		expect(tokenData.repository).toBe('library-vault');
		expect(tokenData.expiresAt).toBeDefined();
	});

	it('provides standard MCP JSON-RPC 2.0 interface for OpenAI Dots', async () => {
		const vault = new LibraryVault();
		const mcp = createMcpRouter(() => vault);

		// 1. GET /mcp (Discovery)
		const resGet = await mcp.request('/');
		expect(resGet.status).toBe(200);
		const getJson = (await resGet.json()) as { name: string; protocol: string; tools: string[] };
		expect(getJson.name).toBe('library-knowledge-vault');
		expect(getJson.protocol).toBe('2024-11-05');
		expect(getJson.tools).toContain('search_vault');
		expect(getJson.tools).toContain('curate_story');

		// 2. POST /mcp initialize
		const resInit = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { clientInfo: { name: 'openai-dot', version: '1.0' } },
			}),
		});
		expect(resInit.status).toBe(200);
		const initJson = (await resInit.json()) as { result: { serverInfo: { name: string } } };
		expect(initJson.result.serverInfo.name).toBe('library-knowledge-vault');

		// 3. POST /mcp tools/list
		const resList = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
			}),
		});
		expect(resList.status).toBe(200);
		const listJson = (await resList.json()) as { result: { tools: Array<{ name: string }> } };
		expect(listJson.result.tools.map((t) => t.name)).toEqual(
			expect.arrayContaining(['search_vault', 'get_note', 'curate_story', 'get_git_sync_info']),
		);

		// 4. POST /mcp tools/call curate_story (Dot curating a paper)
		const resCurate = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: {
					name: 'curate_story',
					arguments: {
						native_id: '99001',
						title: 'Verifiable Agent Checkpoints via Firecracker Snapshots',
						url: 'https://example.com/checkpoints',
						summary: 'Formal verification of agent state restoration.',
						significance: 'Enables deterministic execution resumes.',
						curatorNotes: 'Evaluated by OpenAI Dot.',
						topics: ['Virtualization', 'Verification'],
						concepts: ['[[Firecracker]]', '[[Memory Snapshots]]'],
						significance_score: 0.96,
					},
				},
			}),
		});
		expect(resCurate.status).toBe(200);
		const curateJson = (await resCurate.json()) as { result: { content: Array<{ text: string }> } };
		expect(curateJson.result.content[0].text).toContain('curated');
		expect(curateJson.result.content[0].text).toContain('hn-99001');

		// 5. POST /mcp tools/call search_vault (Dot searching)
		const resSearch = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: {
					name: 'search_vault',
					arguments: { query: 'Firecracker' },
				},
			}),
		});
		expect(resSearch.status).toBe(200);
		const searchJson = (await resSearch.json()) as { result: { content: Array<{ text: string }> } };
		expect(searchJson.result.content[0].text).toContain('Firecracker');

		// 6. POST /mcp tools/call get_note (Dot reading note)
		const resNote = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: {
					name: 'get_note',
					arguments: { path: 'stories/hn-99001.md' },
				},
			}),
		});
		expect(resNote.status).toBe(200);
		const noteJson = (await resNote.json()) as { result: { content: Array<{ text: string }> } };
		expect(noteJson.result.content[0].text).toContain('Verifiable Agent Checkpoints');
	});
});
