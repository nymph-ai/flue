import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
	env: {},
	DurableObject: class {},
}));
import { DatabaseSync } from 'node:sqlite';
import { extractWikilinks, formatConceptNote, formatIndexMOC, formatLogEntry, formatStoryNote, slugify } from '../src/wiki/okf.ts';
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
		const evtListJson = (await resEvtList.json()) as { result: { events: Array<{ name: string }> } };
		expect(evtListJson.result.events.map((e) => e.name)).toContain('task_changed');

		// 4. POST /mcp events/subscribe (establishing scoped subscription before job)
		const resSub = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 3,
				method: 'events/subscribe',
				params: {
					callbackUrl: 'https://chatgpt.openai.com/api/mcp/callbacks/dot-123',
					secret: 'dot_hmac_secret_key_abc123',
					filter: { correlationId: 'chatgpt-thread-456' },
				},
			}),
		});
		expect(resSub.status).toBe(200);
		const subJson = (await resSub.json()) as { result: { subscriptionId: string } };
		expect(subJson.result.subscriptionId).toMatch(/^sub_/);

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
		const taskDataJson = (await resGetTask.json()) as { result: { content: Array<{ text: string }> } };
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
		const replaySubJson = (await resReplaySub.json()) as { result: { replayedEventsCount: number } };
		expect(replaySubJson.result.replayedEventsCount).toBeGreaterThan(0);
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
				subscription: { id: 'sub_mock_123' },
				replayedEvents: [],
			}),
			unsubscribeMcp: vi.fn().mockResolvedValue(true),
			listMcpEvents: vi.fn().mockResolvedValue([]),
			getMcpDeliveries: vi.fn().mockResolvedValue([]),
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

		// 3. Fast read: search through POST /mcp -> should NOT call mockStub, runs at edge against vault
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
		// Verified fast read did not touch DO stub
		expect(mockStub.listMcpEvents).not.toHaveBeenCalled();
	});
});
