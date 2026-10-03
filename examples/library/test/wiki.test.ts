import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
	env: {},
	DurableObject: class {},
}));
import { DatabaseSync } from 'node:sqlite';
import app from '../src/app.ts';
import {
	extractWikilinks,
	formatConceptNote,
	formatIndexMOC,
	formatLogEntry,
	formatStoryNote,
	slugify,
} from '../src/wiki/okf.ts';
import { createMcpRouter } from '../src/mcp/router.ts';
import { TaskStore } from '../src/mcp/tasks.ts';
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
		expect(note).toContain("[[hn-49930412|It's the Kernel's Fault]]");
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
				summary:
					'Introduces bpf_fault, an eBPF extension enabling user-defined in-kernel page fault handlers.',
				significance:
					'Critical for sub-10ms Firecracker snapshot restoration without userfaultfd IPC overhead.',
				curatorNotes: 'High-impact kernel primitive for hypervisors and agent runtimes.',
				topics: ['Systems', 'Linux Kernel', 'eBPF'],
				concepts: ['[[bpf_fault]]', '[[userfaultfd]]', '[[Demand Paging]]'],
				significance_score: 0.94,
				by: sensoryObservation.by,
				score: sensoryObservation.score,
			},
		} as never)) as {
			output: { status: string; storyId: string; conceptsAdded: number; path: string };
		};

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

	it('provides standard MCP 2.0 (2026-07-28) interface with native MCP Events for OpenAI Dots', async () => {
		const vault = new LibraryVault();
		const mcp = createMcpRouter(() => vault);

		// 1. GET /mcp (Discovery)
		const resGet = await mcp.request('/');
		expect(resGet.status).toBe(200);
		const getJson = (await resGet.json()) as {
			name: string;
			protocol: string;
			capabilities: { events: { subscribe: boolean } };
			tools: string[];
			events: string[];
		};
		expect(getJson.name).toBe('library-knowledge-vault');
		expect(getJson.protocol).toBe('2026-07-28');
		expect(getJson.capabilities.events.subscribe).toBe(true);
		expect(getJson.tools).toEqual(
			expect.arrayContaining([
				'submit_task',
				'get_task',
				'get_result',
				'cancel_task',
				'search',
				'fetch',
				'acknowledge_result',
			]),
		);
		expect(getJson.events).toContain('task_changed');

		// 1.5. POST /mcp server/discover (MCP 2026-07-28 stateless discovery)
		const resDiscover = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 99,
				method: 'server/discover',
			}),
		});
		expect(resDiscover.status).toBe(200);
		const discoverJson = (await resDiscover.json()) as {
			result: {
				resultType: string;
				protocolVersion: string;
				supportedVersions: string[];
				capabilities: { events: { subscribe: boolean } };
				tools: Array<{ name: string }>;
				events: Array<{
					name: string;
					delivery: string[];
					inputSchema: object;
					payloadSchema: object;
				}>;
			};
		};
		expect(discoverJson.result.resultType).toBe('complete');
		expect(discoverJson.result.supportedVersions).toContain('2026-07-28');
		expect(discoverJson.result.capabilities.events.subscribe).toBe(true);
		expect(discoverJson.result.tools.length).toBeGreaterThan(0);
		expect(discoverJson.result.events[0]?.delivery).toEqual(['webhook']);
		expect(discoverJson.result.events[0]?.inputSchema).toBeDefined();
		expect(discoverJson.result.events[0]?.payloadSchema).toBeDefined();

		// 2. POST /mcp initialize
		const resInit = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { clientInfo: { name: 'openai-dot', version: '2.0' } },
			}),
		});
		expect(resInit.status).toBe(200);
		const initJson = (await resInit.json()) as {
			result: { protocolVersion: string; capabilities: { events: { subscribe: boolean } } };
		};
		expect(initJson.result.protocolVersion).toBe('2026-07-28');
		expect(initJson.result.capabilities.events.subscribe).toBe(true);

		// 3. POST /mcp events/list
		const resEvtList = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'events/list' }),
		});
		expect(resEvtList.status).toBe(200);
		const evtListJson = (await resEvtList.json()) as {
			result: {
				events: Array<{
					name: string;
					delivery: string[];
					inputSchema: Record<string, unknown>;
					payloadSchema: Record<string, unknown>;
				}>;
			};
		};
		const firstEvent = evtListJson.result.events[0];
		expect(firstEvent).toBeDefined();
		expect(firstEvent?.name).toBe('task_changed');
		expect(firstEvent?.delivery).toEqual(['webhook']);
		expect(firstEvent?.inputSchema).toBeDefined();
		const inputProps = (firstEvent?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
		expect(inputProps?.callbackUrl).toBeUndefined();
		expect(inputProps?.cursor).toBeDefined();
		expect(firstEvent?.payloadSchema).toBeDefined();
		const payloadProps = (firstEvent?.payloadSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
		expect(payloadProps?.cursor).toBeDefined();

		// 4. POST /mcp events/subscribe (establishing scoped subscription with delivery object)
		const resSub = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 3,
				method: 'events/subscribe',
				params: {
					delivery: {
						type: 'webhook',
						url: 'https://chatgpt.openai.com/api/mcp/callbacks/dot-123',
						secret: 'dot_hmac_secret_key_abc123',
					},
					filter: { correlationId: 'chatgpt-thread-456' },
					skipVerification: true,
				},
			}),
		});
		expect(resSub.status).toBe(200);
		const subJson = (await resSub.json()) as {
			result: {
				id: string;
				refreshBefore: string;
				cursor: string | null;
				truncated: boolean;
			};
		};
		expect(subJson.result.id).toMatch(/^sub_/);
		expect(subJson.result.refreshBefore).toBeDefined();
		expect(subJson.result.truncated).toBe(false);

		// 5. POST /mcp tools/call submit_task (asynchronous job submission)
		const resSubmit = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: {
					name: 'submit_task',
					arguments: {
						task_type: 'curate',
						correlation_id: 'chatgpt-thread-456',
						payload: {
							native_id: '99001',
							title: 'Verifiable Agent Checkpoints via Firecracker Snapshots',
							url: 'https://example.com/checkpoints',
							summary: 'Formal verification of agent state restoration.',
							significance: 'Enables deterministic sub-10ms resumes.',
							curatorNotes: 'Evaluated by OpenAI Dot coworker.',
							topics: ['Virtualization', 'Verification'],
							concepts: ['[[Firecracker]]', '[[Memory Snapshots]]'],
							significance_score: 0.96,
						},
					},
				},
			}),
		});
		expect(resSubmit.status).toBe(200);
		const submitJson = (await resSubmit.json()) as { result: { content: Array<{ text: string }> } };
		const submitData = JSON.parse(submitJson.result.content[0]!.text) as {
			taskId: string;
			status: string;
			revision: number;
		};
		expect(submitData.taskId).toMatch(/^task_/);
		expect(submitData.status).toBe('queued');
		expect(submitData.revision).toBe(1);

		const taskId = submitData.taskId;

		// 6. POST /mcp tools/call get_task
		const resGetTask = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: {
					name: 'get_task',
					arguments: { task_id: taskId },
				},
			}),
		});
		expect(resGetTask.status).toBe(200);
		const taskDataJson = (await resGetTask.json()) as {
			result: { content: Array<{ text: string }> };
		};
		const taskData = JSON.parse(taskDataJson.result.content[0]!.text) as {
			id: string;
			status: string;
			revision: number;
		};
		expect(taskData.id).toBe(taskId);
		expect(taskData.revision).toBeGreaterThanOrEqual(1);

		// 7. POST /mcp tools/call get_result (fetching durable result)
		const resResult = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 6,
				method: 'tools/call',
				params: {
					name: 'get_result',
					arguments: { task_id: taskId },
				},
			}),
		});
		expect(resResult.status).toBe(200);
		const resultJson = (await resResult.json()) as { result: { content: Array<{ text: string }> } };
		const resultData = JSON.parse(resultJson.result.content[0]!.text) as {
			taskId: string;
			status: string;
			sources: Array<{ title: string; url: string }>;
			versions: { model: string; schema: string };
			limitations: string[];
			artifacts: string[];
			acknowledged: boolean;
		};
		expect(resultData.taskId).toBe(taskId);
		expect(resultData.status).toBe('completed');
		expect(resultData.sources.length).toBeGreaterThan(0);
		expect(resultData.versions.schema).toBe('okf/v1');
		expect(resultData.artifacts).toContain('stories/hn-99001.md');
		expect(resultData.acknowledged).toBe(false);

		// 8. POST /mcp tools/call acknowledge_result (explicit client proof of read)
		const resAck = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 7,
				method: 'tools/call',
				params: {
					name: 'acknowledge_result',
					arguments: {
						task_id: taskId,
						receipt: { threadId: 'chatgpt-thread-456', readBy: 'dot-astra-1' },
					},
				},
			}),
		});
		expect(resAck.status).toBe(200);
		const ackJson = (await resAck.json()) as { result: { content: Array<{ text: string }> } };
		const ackData = JSON.parse(ackJson.result.content[0]!.text) as { acknowledged: boolean };
		expect(ackData.acknowledged).toBe(true);

		// Verify result is now marked acknowledged
		const resResultAcked = await mcp.request(`/results/${taskId}`);
		expect(resResultAcked.status).toBe(200);
		const resultAckedJson = (await resResultAcked.json()) as { acknowledged: boolean };
		expect(resultAckedJson.acknowledged).toBe(true);

		// 9. POST /mcp tools/call search
		const resSearch = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 8,
				method: 'tools/call',
				params: {
					name: 'search',
					arguments: { query: 'Firecracker' },
				},
			}),
		});
		expect(resSearch.status).toBe(200);
		const searchJson = (await resSearch.json()) as { result: { content: Array<{ text: string }> } };
		expect(searchJson.result.content[0]!.text).toContain('Firecracker');

		// 10. POST /mcp tools/call fetch
		const resFetch = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 9,
				method: 'tools/call',
				params: {
					name: 'fetch',
					arguments: { path: 'stories/hn-99001.md' },
				},
			}),
		});
		expect(resFetch.status).toBe(200);
		const fetchJson = (await resFetch.json()) as { result: { content: Array<{ text: string }> } };
		expect(fetchJson.result.content[0]!.text).toContain('Verifiable Agent Checkpoints');

		// 11. Test Replay & Deduplication: Subscribing with fromRevision: 1 replays events
		const resReplaySub = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 10,
				method: 'events/subscribe',
				params: {
					callbackUrl: 'https://chatgpt.openai.com/api/mcp/callbacks/dot-123',
					filter: { taskId },
					fromRevision: 1,
				},
			}),
		});
		expect(resReplaySub.status).toBe(200);
		const replaySubJson = (await resReplaySub.json()) as {
			result: { id: string; cursor: string | null; truncated: boolean };
		};
		expect(replaySubJson.result.id).toMatch(/^sub_/);
		expect(replaySubJson.result.cursor).toBeDefined();
		expect(replaySubJson.result.truncated).toBe(false);
	});

	it('persists tasks, results, events, and subscriptions to SQLite via TaskStore with Durable Object storage', async () => {
		const db = new DatabaseSync(':memory:');
		const sql = {
			exec: (query: string, ...bindings: unknown[]) => {
				const stmt = db.prepare(query);
				const cleanBindings = bindings.map((b) => (b === undefined ? null : b));
				if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) {
					const rows = stmt.all(...(cleanBindings as never[])) as Record<string, unknown>[];
					return { toArray: () => rows };
				}
				stmt.run(...(cleanBindings as never[]));
				return { toArray: () => [] };
			},
		};

		const waitUntilPromises: Promise<unknown>[] = [];
		const mockCtx = {
			waitUntil: (p: Promise<unknown>) => {
				waitUntilPromises.push(p);
			},
		};

		const vault = new LibraryVault();
		const store = new TaskStore(() => vault, { sql, ctx: mockCtx });

		// 1. Submit task
		const task = store.submitTask({
			type: 'curate',
			correlationId: 'sqlite-thread-001',
			payload: {
				native_id: '4999901',
				title: 'Zero-Copy IO with io_uring and BPF',
				url: 'https://example.com/io_uring',
				summary: 'Modern Linux async IO primitives.',
				significance: 'Enables high-throughput sensor telemetry.',
				curatorNotes: 'Evaluated by OpenAI Dot.',
				topics: ['Kernel', 'IO'],
				concepts: ['[[io_uring]]', '[[zero-copy]]'],
				significance_score: 0.95,
			},
		});

		expect(task.id).toMatch(/^task_/);
		expect(task.status).toBe('queued');
		expect(task.revision).toBe(1);

		// Verify task was immediately written to SQLite table mcp_tasks
		const taskRows = db.prepare('SELECT * FROM mcp_tasks WHERE id = ?').all(task.id) as Array<{
			id: string;
			status: string;
			revision: number;
		}>;
		expect(taskRows.length).toBe(1);
		expect(taskRows[0]!.status).toBe('queued');
		expect(taskRows[0]!.revision).toBe(1);

		// Verify queued event was recorded in mcp_events
		const eventRows = db
			.prepare('SELECT * FROM mcp_events WHERE task_id = ?')
			.all(task.id) as Array<{ event: string; status: string }>;
		expect(eventRows.length).toBeGreaterThanOrEqual(1);
		expect(eventRows[0]!.status).toBe('queued');

		// 2. Wait for background execution triggered via ctx.waitUntil
		await Promise.all(waitUntilPromises);

		// 3. Verify task updated to completed in SQLite
		const completedTask = store.getTask(task.id);
		expect(completedTask).not.toBeNull();
		expect(completedTask?.status).toBe('completed');
		expect(completedTask?.revision).toBe(3); // queued -> running -> completed

		// Verify result stored in mcp_results table in SQLite
		const result = store.getResult(task.id);
		expect(result).not.toBeNull();
		expect(result?.status).toBe('completed');
		expect(result?.artifacts).toContain('stories/hn-4999901.md');
		expect(result?.acknowledged).toBe(false);

		// Verify vault note was persisted in mcp_vault_files table in SQLite and accessible via getNote
		expect(store.getNote('stories/hn-4999901.md')).toContain('Zero-Copy IO');
		expect(store.getNote('concepts/io-uring.md')).not.toBeNull();
		expect(store.listNotes('stories/')).toContain('stories/hn-4999901.md');

		const resultRows = db
			.prepare('SELECT * FROM mcp_results WHERE task_id = ?')
			.all(task.id) as Array<{ task_id: string; acknowledged: number }>;
		expect(resultRows.length).toBe(1);
		expect(resultRows[0]!.acknowledged).toBe(0);

		// 4. Acknowledge result
		const ackOk = store.acknowledgeResult(task.id, { clientProcessed: true });
		expect(ackOk).toBe(true);

		const ackedResult = store.getResult(task.id);
		expect(ackedResult?.acknowledged).toBe(true);
		expect(ackedResult?.acknowledgedAt).toBeDefined();

		const resultRowsAfterAck = db
			.prepare('SELECT acknowledged FROM mcp_results WHERE task_id = ?')
			.all(task.id) as Array<{ acknowledged: number }>;
		expect(resultRowsAfterAck[0]!.acknowledged).toBe(1);

		// 5. Scoped subscription & event replay from SQLite
		const subRes = await store.subscribe({
			callbackUrl: 'https://example.com/webhook',
			filter: { taskId: task.id },
			fromRevision: 1,
		});
		expect(subRes.subscription.id).toMatch(/^sub_/);
		expect(subRes.replayedEvents.length).toBeGreaterThanOrEqual(2);

		const subRows = db
			.prepare('SELECT * FROM mcp_subscriptions WHERE id = ?')
			.all(subRes.subscription.id) as Array<{ id: string }>;
		expect(subRows.length).toBe(1);

		// 6. Unsubscribe deletes from SQLite
		const unsubOk = store.unsubscribe(subRes.subscription.id);
		expect(unsubOk).toBe(true);
		const subRowsAfter = db
			.prepare('SELECT * FROM mcp_subscriptions WHERE id = ?')
			.all(subRes.subscription.id) as Array<{ id: string }>;
		expect(subRowsAfter.length).toBe(0);

		// 7. Cancellation
		const task2 = store.submitTask({
			type: 'curate',
			payload: { title: 'To be cancelled' },
		});
		const cancelOk = store.cancelTask(task2.id, 'User requested stop');
		expect(cancelOk).toBe(true);

		const cancelledTask = store.getTask(task2.id);
		expect(cancelledTask?.status).toBe('cancelled');

		const cancelledRows = db
			.prepare('SELECT status, summary FROM mcp_tasks WHERE id = ?')
			.all(task2.id) as Array<{ status: string; summary: string }>;
		expect(cancelledRows[0]!.status).toBe('cancelled');
		expect(cancelledRows[0]!.summary).toBe('User requested stop');
	});

	it('createMcpRouter delegates stateful operations via DO RPC to FLUE_CURATOR_AGENT and keeps fast reads at edge', async () => {
		const vault = new LibraryVault();
		await vault.saveStoryNote({
			schema_version: 'okf/v1',
			id: 'hn-5555',
			type: 'story',
			title: 'Edge Search Story',
			resource: 'https://example.com/search',
			source: 'hackernews',
			native_id: '5555',
			timestamp: '2026-10-02T10:00:00Z',
			curator: 'curator',
			curator_model: 'meta/muse-spark-1.3-contributor',
			significance_score: 0.9,
			topics: ['Edge'],
			concepts: ['[[Cloudflare Workers]]'],
			tags: ['#edge'],
			summary: 'Fast edge search demonstration.',
			significance: 'Sub-10ms response.',
			curatorNotes: 'Evaluated at edge.',
		});

		const mockStub = {
			submitMcpTask: vi.fn().mockResolvedValue({
				id: 'task_mock_123',
				status: 'queued',
				revision: 1,
				createdAt: '2026-10-02T10:00:00Z',
				correlationId: 'corr-do-rpc',
			}),
			getMcpTask: vi.fn().mockResolvedValue({
				id: 'task_mock_123',
				status: 'completed',
				revision: 2,
			}),
			getMcpResult: vi.fn().mockResolvedValue({
				taskId: 'task_mock_123',
				status: 'completed',
				summary: 'Result from DO RPC',
			}),
			cancelMcpTask: vi.fn().mockResolvedValue(true),
			acknowledgeMcpResult: vi.fn().mockResolvedValue(true),
			subscribeMcp: vi.fn().mockResolvedValue({
				subscription: { id: 'sub_mock_123', callbackUrl: 'https://example.com/webhook' },
				replayedEvents: [],
				cursor: '0',
			}),
			unsubscribeMcp: vi.fn().mockResolvedValue(true),
			listMcpEvents: vi.fn().mockResolvedValue([]),
			getMcpDeliveries: vi.fn().mockResolvedValue([]),
			getMcpNote: vi
				.fn()
				.mockImplementation((p: string) => (p.includes('mock') ? '# Mock Note Content' : null)),
			listMcpNotes: vi.fn().mockResolvedValue(['stories/hn-mock.md']),
		};

		const envWithDO = {
			FLUE_CURATOR_AGENT: {
				getByName: vi.fn().mockReturnValue(mockStub),
			},
		};

		const router = createMcpRouter(() => vault);

		// 1. Submit task through POST /mcp -> should delegate to mockStub.submitMcpTask
		const resSubmit = await router.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'submit_task',
						arguments: {
							task_type: 'curate',
							correlation_id: 'corr-do-rpc',
							payload: { title: 'RPC Story' },
						},
					},
				}),
			}),
			envWithDO,
		);
		expect(resSubmit.status).toBe(200);
		expect(mockStub.submitMcpTask).toHaveBeenCalledWith({
			type: 'curate',
			correlationId: 'corr-do-rpc',
			payload: { title: 'RPC Story' },
		});

		// 2. Query get_task through POST /mcp -> should delegate to mockStub.getMcpTask
		const resGetTask = await router.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: {
						name: 'get_task',
						arguments: { task_id: 'task_mock_123' },
					},
				}),
			}),
			envWithDO,
		);
		expect(resGetTask.status).toBe(200);
		expect(mockStub.getMcpTask).toHaveBeenCalledWith('task_mock_123');

		// 3. Fast read: search through POST /mcp -> searches edge vault and falls back to store
		const resSearch = await router.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: {
						name: 'search',
						arguments: { query: 'Edge Search Story' },
					},
				}),
			}),
			envWithDO,
		);
		expect(resSearch.status).toBe(200);
		const searchData = (await resSearch.json()) as { result: { content: Array<{ text: string }> } };
		expect(searchData.result.content[0]!.text).toContain('Edge Search Story');

		// 4. Fetch note stored in DO TaskStore (e.g. from prior asynchronous tasks)
		const resFetchStore = await router.fetch(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 4,
					method: 'tools/call',
					params: {
						name: 'fetch',
						arguments: { path: 'stories/hn-mock.md' },
					},
				}),
			}),
			envWithDO,
		);
		expect(resFetchStore.status).toBe(200);
		const fetchStoreData = (await resFetchStore.json()) as {
			result: { content: Array<{ text: string }> };
		};
		expect(fetchStoreData.result.content[0]!.text).toContain('# Mock Note Content');
		expect(mockStub.getMcpNote).toHaveBeenCalledWith('stories/hn-mock.md');
	});

	it('handles CORS preflight (OPTIONS) and provides discovery manifests for OpenAI Plugins & Dots', async () => {
		// 1. CORS Preflight OPTIONS /mcp
		const resCors = await app.request('/mcp', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://chatgpt.com',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'Content-Type, x-mcp-event-signature',
			},
		});
		expect(resCors.status).toBe(204);
		expect(resCors.headers.get('access-control-allow-origin')).toBe('*');
		expect(resCors.headers.get('access-control-allow-methods')).toContain('POST');
		expect(resCors.headers.get('access-control-allow-headers')).toContain('x-mcp-event-signature');

		// 2. OpenAI Plugin Manifest: /.well-known/ai-plugin.json
		const resPlugin = await app.request('/.well-known/ai-plugin.json');
		expect(resPlugin.status).toBe(200);
		const pluginJson = (await resPlugin.json()) as {
			schema_version: string;
			name_for_model: string;
			api: { type: string; url: string };
		};
		expect(pluginJson.schema_version).toBe('v1');
		expect(pluginJson.name_for_model).toBe('autonomous_knowledge_vault');
		expect(pluginJson.api.type).toBe('openapi');
		expect(pluginJson.api.url).toContain('/openapi.json');

		// 3. MCP 2.0 Manifest: /.well-known/mcp.json
		const resMcpManifest = await app.request('/.well-known/mcp.json');
		expect(resMcpManifest.status).toBe(200);
		const mcpManifestJson = (await resMcpManifest.json()) as {
			protocolVersion: string;
			capabilities: { events: { subscribe: boolean } };
			endpoints: {
				rpc: string;
				tasks: string;
				results: string;
				events: string;
				deliveries: string;
			};
		};
		expect(mcpManifestJson.protocolVersion).toBe('2026-07-28');
		expect(mcpManifestJson.capabilities.events.subscribe).toBe(true);
		expect(mcpManifestJson.endpoints.rpc).toContain('/mcp');

		// 4. OpenAPI Specification: /openapi.json & /mcp/openapi.json
		const resOpenApi = await app.request('/openapi.json');
		expect(resOpenApi.status).toBe(200);
		const openApiJson = (await resOpenApi.json()) as {
			openapi: string;
			paths: Record<string, unknown>;
		};
		expect(openApiJson.openapi).toBe('3.1.0');
		expect(openApiJson.paths['/mcp']).toBeDefined();
		expect(openApiJson.paths['/mcp/tasks/{id}']).toBeDefined();
		expect(openApiJson.paths['/mcp/results/{id}']).toBeDefined();
		expect(openApiJson.paths['/mcp/test-callback']).toBeDefined();

		const resMcpOpenApi = await app.request('/mcp/openapi.json');
		expect(resMcpOpenApi.status).toBe(200);
	});

	it('proves end-to-end conversation wake loop: subscribe -> submit_task -> idle -> background signed webhook wake -> fetch result -> acknowledge', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (
				urlStr.startsWith('http://localhost') ||
				urlStr.startsWith('https://library.nymphai.workers.dev')
			) {
				const req = input instanceof Request ? input : new Request(urlStr, init);
				return app.fetch(req);
			}
			return originalFetch(input, init);
		});

		try {
			// Clear test callback inbox
			await app.request('/mcp/test-callback', { method: 'DELETE' });

			const testSecret = 'dots_webhook_hmac_secret_super_secure_998';
			const correlationId = 'dots-thread-wake-test-001';

			// 1. OpenAI Dots registers webhook subscription with signed callback before going idle
			const resSub = await app.request('/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'events/subscribe',
					params: {
						delivery: {
							type: 'webhook',
							url: `http://localhost/mcp/test-callback?secret=${testSecret}`,
							secret: testSecret,
						},
						filter: { correlationId },
					},
				}),
			});
			expect(resSub.status).toBe(200);
			const subJson = (await resSub.json()) as {
				result: {
					id: string;
					refreshBefore: string;
					cursor: string | null;
					truncated: boolean;
				};
			};
			expect(subJson.result.id).toMatch(/^sub_/);
			expect(subJson.result.refreshBefore).toBeDefined();
			expect(subJson.result.truncated).toBe(false);

			// 2. OpenAI Dots submits an asynchronous long-running task
			const resSubmit = await app.request('/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: {
						name: 'submit_task',
						arguments: {
							task_type: 'curate',
							correlation_id: correlationId,
							payload: {
								native_id: '887766',
								title: 'Deterministic Wasm Sandbox Snapshotting in Edge Workers',
								url: 'https://example.com/wasm-sandbox',
								summary: 'Enables sub-millisecond cold starts using linear memory snapshotting.',
								significance: 'Critical primitive for resilient agent memory state.',
								curatorNotes: 'Evaluated by OpenAI Dots coworker.',
								topics: ['Wasm', 'Sandboxing', 'Edge'],
								concepts: ['[[Wasm Sandbox]]', '[[Linear Memory]]'],
								significance_score: 0.98,
							},
						},
					},
				}),
			});
			expect(resSubmit.status).toBe(200);
			const submitData = (await resSubmit.json()) as {
				result: { content: Array<{ text: string }> };
			};
			const parsedTask = JSON.parse(submitData.result.content[0]!.text) as {
				taskId: string;
				status: string;
				revision: number;
			};
			expect(parsedTask.taskId).toMatch(/^task_/);
			expect(parsedTask.status).toBe('queued');
			const taskId = parsedTask.taskId;

			// 3. Dots conversation goes IDLE — wait for asynchronous background task execution & webhook delivery
			await new Promise((resolve) => setTimeout(resolve, 80));

			// 4. Verify the webhook receiver caught the wake callback with a verified HMAC signature
			const resCallbacks = await app.request('/mcp/test-callback');
			expect(resCallbacks.status).toBe(200);
			const callbacksData = (await resCallbacks.json()) as {
				total: number;
				callbacks: Array<{
					headers: Record<string, string>;
					payload: {
						name: string;
						eventId: string;
						timestamp: string;
						data: { event: string; taskId: string; status: string; revision: number };
						cursor: string;
					};
					signatureValid: boolean;
				}>;
			};

			expect(callbacksData.total).toBeGreaterThanOrEqual(1);
			// Find the completion event callback
			const completionWake = callbacksData.callbacks.find(
				(c) => c.payload.data?.taskId === taskId && c.payload.data?.status === 'completed',
			);
			expect(completionWake).toBeDefined();
			expect(completionWake?.signatureValid).toBe(true);
			expect(completionWake?.headers['webhook-signature']).toMatch(/^v1,/);
			expect(completionWake?.headers['webhook-id']).toBeDefined();
			expect(completionWake?.headers['webhook-timestamp']).toBeDefined();
			expect(completionWake?.headers['x-mcp-subscription-id']).toBe(subJson.result.id);
			expect(completionWake?.headers['x-mcp-event-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
			expect(completionWake?.headers['x-mcp-task-id']).toBe(taskId);
			expect(completionWake?.headers['x-mcp-cursor']).toBe('3');
			expect(completionWake?.payload.name).toBe('task_changed');
			expect(completionWake?.payload.data.revision).toBe(3);
			expect(completionWake?.payload.cursor).toBe('3');

			// 5. Dots "wakes" up from idle and calls get_result(taskId) to retrieve completed artifacts
			const resResult = await app.request('/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: {
						name: 'get_result',
						arguments: { task_id: taskId },
					},
				}),
			});
			expect(resResult.status).toBe(200);
			const resultData = (await resResult.json()) as {
				result: { content: Array<{ text: string }> };
			};
			const parsedResult = JSON.parse(resultData.result.content[0]!.text) as {
				taskId: string;
				status: string;
				artifacts: string[];
				sources: Array<{ title: string }>;
				acknowledged: boolean;
			};
			expect(parsedResult.taskId).toBe(taskId);
			expect(parsedResult.status).toBe('completed');
			expect(parsedResult.sources[0]?.title).toBe(
				'Deterministic Wasm Sandbox Snapshotting in Edge Workers',
			);
			expect(parsedResult.artifacts).toContain('stories/hn-887766.md');
			expect(parsedResult.acknowledged).toBe(false);

			// 6. Dots acknowledges result processing
			const resAck = await app.request('/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 4,
					method: 'tools/call',
					params: {
						name: 'acknowledge_result',
						arguments: {
							task_id: taskId,
							receipt: { threadId: correlationId, client: 'openai-dots' },
						},
					},
				}),
			});
			expect(resAck.status).toBe(200);

			// 7. Verify delivery audit trail
			const resDeliveries = await app.request(`/mcp/deliveries/${taskId}`);
			expect(resDeliveries.status).toBe(200);
			const deliveriesData = (await resDeliveries.json()) as {
				total: number;
				deliveries: Array<{ status: string; statusCode: number }>;
			};
			expect(deliveriesData.total).toBeGreaterThanOrEqual(1);
			expect(deliveriesData.deliveries[0]?.status).toBe('delivered');
			expect(deliveriesData.deliveries[0]?.statusCode).toBe(200);

			// 8. Verify audit logs
			const resAudit = await app.request('/mcp/audit-logs');
			expect(resAudit.status).toBe(200);
			const auditData = (await resAudit.json()) as {
				total: number;
				logs: Array<{ category: string; details: any }>;
			};
			expect(auditData.total).toBeGreaterThanOrEqual(1);
			const categories = auditData.logs.map((l) => l.category);
			expect(categories).toContain('events/subscribe:received');
			expect(categories).toContain('events/subscribe:success');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('handles OpenAI Standard Webhooks whsec_ URL-safe secrets and challenge verification', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (
				urlStr.startsWith('http://localhost') ||
				urlStr.startsWith('https://library.nymphai.workers.dev')
			) {
				const req = input instanceof Request ? input : new Request(urlStr, init);
				return app.fetch(req);
			}
			return originalFetch(input, init);
		});

		try {
			await app.request('/mcp/test-callback', { method: 'DELETE' });

			// Standard OpenAI whsec_ secret with URL-safe base64 (- and _) and unpadded
			const urlSafeSecret = 'whsec_MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-1_abc99';
			const resSub = await app.request('/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 10,
					method: 'events/subscribe',
					params: {
						delivery: {
							type: 'webhook',
							url: `http://localhost/mcp/test-callback?secret=${urlSafeSecret}`,
							secret: urlSafeSecret,
						},
						filter: { taskId: 'task-test-urlsafe' },
					},
				}),
			});
			expect(resSub.status).toBe(200);
			const subJson = (await resSub.json()) as any;
			expect(subJson.result.id).toMatch(/^sub_/);

			const resInbox = await app.request('/mcp/test-callback');
			const inbox = (await resInbox.json()) as {
				callbacks: Array<{ headers: Record<string, string>; payload: any }>;
			};
			const chg = inbox.callbacks.find((c) => c.payload?.type === 'verification');
			expect(subJson.result.refreshBefore).toBeDefined();
			expect(chg).toBeDefined();
			expect(chg?.headers['x-mcp-subscription-id']).toBe(subJson.result.id);
			expect(chg?.headers['mcp-method']).toBe('events/subscribe');
			expect(chg?.headers['webhook-signature']).toMatch(/^v1,/);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('handles exact OpenAI ChatGPT events/subscribe payload structure with arguments.filter and exposes get_audit_logs tool', async () => {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (
				urlStr.startsWith('http://localhost') ||
				urlStr.startsWith('https://library.nymphai.workers.dev')
			) {
				const req = input instanceof Request ? input : new Request(urlStr, init);
				return app.fetch(req);
			}
			return originalFetch(input, init);
		});

		try {
			await app.request('/mcp/test-callback', { method: 'DELETE' });

			const secret = 'whsec_MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-1_abc99';
			const correlationId = 'nyai-wake-test-20261003-exact-openai';

			// Exactly matches what ChatGPT OpenAI MCP client transmits
			const resSub = await app.request('/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 11,
					method: 'events/subscribe',
					params: {
						name: 'task_changed',
						arguments: {
							filter: {
								correlationId,
							},
						},
						delivery: {
							mode: 'webhook',
							url: `http://localhost/mcp/test-callback?secret=${secret}`,
							secret,
						},
						cursor: null,
					},
				}),
			});
			expect(resSub.status).toBe(200);
			const subJson = (await resSub.json()) as any;
			expect(subJson.result.id).toMatch(/^sub_/);
			expect(subJson.result.refreshBefore).toBeDefined();
			expect(subJson.result.cursor).toBeNull();
			expect(subJson.result.truncated).toBe(false);

			// Verify get_audit_logs MCP tool
			const resTool = await app.request('/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 12,
					method: 'tools/call',
					params: {
						name: 'get_audit_logs',
						arguments: { limit: 10 },
					},
				}),
			});
			expect(resTool.status).toBe(200);
			const toolJson = (await resTool.json()) as any;
			expect(toolJson.result.content[0].text).toContain('events/subscribe:received');
			expect(toolJson.result.content[0].text).toContain('events/subscribe:success');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('formats distinct OKF concept notes with slug resolution and contextual excerpts in research tasks', async () => {
		const db = new DatabaseSync(':memory:');
		const sql = {
			exec: (query: string, ...bindings: unknown[]) => {
				const stmt = db.prepare(query);
				const cleanBindings = bindings.map((b) => (b === undefined ? null : b));
				if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) {
					const rows = stmt.all(...(cleanBindings as never[])) as Record<string, unknown>[];
					return { toArray: () => rows };
				}
				stmt.run(...(cleanBindings as never[]));
				return { toArray: () => [] };
			},
		};

		const waitUntilPromises: Promise<unknown>[] = [];
		const mockCtx = {
			waitUntil: (p: Promise<unknown>) => {
				waitUntilPromises.push(p);
			},
		};

		const vault = new LibraryVault();
		const store = new TaskStore(() => vault, { sql, ctx: mockCtx });

		// Seed a story curation task into store
		const task = store.submitTask({
			type: 'curate',
			payload: {
				native_id: '990099',
				title: 'Cloudflare Workers & Durable Objects',
				url: 'https://blog.cloudflare.com/workers-and-durable-objects',
				topics: ['Cloudflare', 'Serverless'],
				concepts: ['[[Cloudflare Workers]]', '[[Durable Objects]]'],
				summary: 'Deep dive into stateful serverless with Durable Objects.',
			},
		});

		await Promise.all(waitUntilPromises);

		// 1. Verify getNote on story note
		const storyContent = store.getNote('stories/hn-990099.md');
		expect(storyContent).not.toBeNull();
		expect(storyContent).toContain('type: story');
		expect(storyContent).toContain('Cloudflare Workers & Durable Objects');

		// 2. Verify getNote on concept note by slug and title
		const conceptSlug = store.getNote('concepts/durable-objects.md');
		expect(conceptSlug).not.toBeNull();
		expect(conceptSlug).toContain('type: concept');
		expect(conceptSlug).not.toContain('type: story');
		expect(conceptSlug).toContain('# Concept: Durable Objects');
		expect(conceptSlug).toMatch(
			/\[\[hn-990099\|(Cloudflare Workers & Durable Objects|Deep dive into stateful serverless with Durable Objects\.)\]\]/,
		);

		const conceptTitle = store.getNote('concepts/Durable Objects.md');
		expect(conceptTitle).not.toBeNull();
		expect(conceptTitle).toContain('type: concept');
		expect(conceptTitle).not.toContain('type: story');

		// 3. Verify listNotes canonicalizes concept paths
		const allNotes = store.listNotes();
		expect(allNotes).toContain('concepts/cloudflare-workers.md');
		expect(allNotes).toContain('concepts/durable-objects.md');
		expect(allNotes).not.toContain('concepts/Durable Objects.md'); // canonicalized to slug

		// 4. Run research task for "Cloudflare"
		const researchTask = store.submitTask({
			type: 'research',
			payload: { query: 'Cloudflare' },
		});
		await Promise.all(waitUntilPromises);

		const researchResult = store.getResult(researchTask.id);
		expect(researchResult).not.toBeNull();
		const matches = JSON.parse(researchResult!.content) as Array<{ path: string; excerpt: string }>;
		expect(matches.length).toBeGreaterThanOrEqual(2);

		// Every concept match MUST have type: concept in its excerpt or note, NEVER type: story
		for (const m of matches) {
			if (m.path.startsWith('concepts/')) {
				const note = store.getNote(m.path);
				expect(note).toContain('type: concept');
				expect(note).not.toContain('type: story');
			}
		}

		db.close();
	});
});
