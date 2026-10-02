/**
 * Model Context Protocol (MCP) server endpoints for OpenAI Dots and AI coworkers.
 * Exposes the Google OKF knowledge vault over standard MCP JSON-RPC 2.0 (2024-11-05).
 */
import { Hono } from 'hono';
import { liveModel } from '../model.ts';
import { getOrCreateVault } from '../wiki/routes.ts';
import { LibraryVault } from '../wiki/storage.ts';
import type { ArtifactsBinding, GitSyncInfo, OKFStoryNote } from '../wiki/types.ts';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = {
	name: 'library-knowledge-vault',
	version: '1.0.0',
};

export const MCP_TOOLS = [
	{
		name: 'search_vault',
		description:
			'Search technical stories, concepts, and notes in the Google Open Knowledge Format (OKF) knowledge vault.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'The search query to match against story titles, summaries, and concept notes.',
				},
				type: {
					type: 'string',
					enum: ['all', 'stories', 'concepts'],
					description: 'Filter search by note type (default: all).',
				},
			},
			required: ['query'],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: 'get_note',
		description:
			'Get the raw Google OKF markdown content of any note in the vault (stories/<id>.md, concepts/<slug>.md, or index.md).',
		inputSchema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'The relative vault path of the note, e.g. "stories/hn-49930412.md" or "concepts/bpf-fault.md".',
				},
			},
			required: ['path'],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: 'curate_story',
		description:
			'Curate a technical paper, literature, or story into the knowledge vault in Google Open Knowledge Format (OKF) with [[wikilinks]].',
		inputSchema: {
			type: 'object',
			properties: {
				native_id: { type: 'string', description: 'Unique identifier or discussion ID (e.g. "49930412").' },
				title: { type: 'string', description: 'The title of the technical literature or paper.' },
				url: { type: 'string', description: 'Direct URL to the primary research paper or article.' },
				summary: { type: 'string', description: 'Concise executive summary of what this research introduces.' },
				significance: { type: 'string', description: 'Technical significance and analysis of why this matters.' },
				curatorNotes: { type: 'string', description: 'Assessment notes from the curator/agent.' },
				topics: {
					type: 'array',
					items: { type: 'string' },
					description: 'High-level topic categories (e.g. ["Systems", "Linux Kernel"]).',
				},
				concepts: {
					type: 'array',
					items: { type: 'string' },
					description: 'Key technical concepts formatted as [[wikilinks]], e.g. ["[[bpf_fault]]", "[[userfaultfd]]"].',
				},
				significance_score: {
					type: 'number',
					description: 'Technical significance score between 0.0 and 1.0 (default: 0.9).',
				},
				by: { type: 'string', description: 'Author or submitter handle.' },
				score: { type: 'number', description: 'Community score / upvotes if applicable.' },
			},
			required: ['native_id', 'title', 'url', 'summary', 'significance', 'curatorNotes', 'topics', 'concepts'],
		},
		annotations: { destructiveHint: false },
	},
	{
		name: 'get_git_sync_info',
		description:
			'Get Cloudflare Artifacts Git repository metadata, clone URL, and token instructions for Obsidian and Dots.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		annotations: { readOnlyHint: true },
	},
];

function rpcSuccess(id: unknown, result: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function toolResult(id: unknown, text: string, isError = false): Response {
	return rpcSuccess(id, {
		content: [{ type: 'text', text }],
		...(isError ? { isError: true } : {}),
	});
}

/**
 * Dispatches an asynchronous MCP Event notification to an OpenAI Dot or webhook subscriber.
 */
export async function notifyDotWebhook(
	webhookUrl: string,
	story: OKFStoryNote,
	vaultPath: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
	try {
		const res = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				event: 'library.story_curated',
				schema_version: 'okf/v1',
				timestamp: new Date().toISOString(),
				story_id: story.id,
				title: story.title,
				url: story.resource,
				significance_score: story.significance_score,
				significance: story.significance,
				concepts: story.concepts,
				topics: story.topics,
				vault_path: vaultPath,
			}),
		});
		return { ok: res.ok, status: res.status };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function createMcpRouter(getVault: (env?: Record<string, unknown>) => LibraryVault = getOrCreateVault) {
	const router = new Hono<{ Bindings: Record<string, unknown> }>();

	// GET /mcp — Discovery endpoint
	router.get('/', (c) =>
		c.json({
			name: SERVER_INFO.name,
			version: SERVER_INFO.version,
			protocol: MCP_PROTOCOL_VERSION,
			transport: 'http-jsonrpc',
			tools: MCP_TOOLS.map((t) => t.name),
		}),
	);

	// POST /mcp — JSON-RPC 2.0 Handler
	router.post('/', async (c) => {
		let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
		try {
			body = (await c.req.json()) ?? {};
		} catch {
			return rpcError(null, -32700, 'Parse error: invalid JSON');
		}

		const id = body.id ?? null;
		const method = body.method;

		// 1. initialize
		if (method === 'initialize') {
			return rpcSuccess(id, {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {
					tools: { listChanged: false },
				},
				serverInfo: SERVER_INFO,
				instructions:
					'Autonomous Knowledge Vault in Google Open Knowledge Format (OKF) backed by Cloudflare Artifacts and Muse Spark on Pi.',
			});
		}

		// 2. notifications/initialized (client ack, no response id)
		if (method === 'notifications/initialized') {
			return new Response(null, { status: 204 });
		}

		// 3. ping
		if (method === 'ping') {
			return rpcSuccess(id, {});
		}

		// 4. tools/list
		if (method === 'tools/list') {
			return rpcSuccess(id, { tools: MCP_TOOLS });
		}

		// 5. tools/call
		if (method === 'tools/call') {
			const params = body.params ?? {};
			const toolName = String(params.name ?? '');
			const args = (params.arguments ?? {}) as Record<string, unknown>;
			const vault = getVault(c.env);

			switch (toolName) {
				case 'search_vault': {
					const query = String(args.query ?? '').toLowerCase();
					if (!query) return toolResult(id, 'search_vault requires a query argument', true);
					const allPaths = await vault.listNotes();
					const targetType = args.type ? String(args.type) : 'all';

					const targetPaths = allPaths.filter((p) => {
						if (targetType === 'stories') return p.startsWith('stories/');
						if (targetType === 'concepts') return p.startsWith('concepts/');
						return true;
					});

					const matches: Array<{ path: string; excerpt: string }> = [];
					for (const path of targetPaths) {
						const content = await vault.getNote(path);
						if (content && content.toLowerCase().includes(query)) {
							const idx = content.toLowerCase().indexOf(query);
							const start = Math.max(0, idx - 60);
							const end = Math.min(content.length, idx + 100);
							matches.push({
								path,
								excerpt: `...${content.slice(start, end).replace(/\n+/g, ' ')}...`,
							});
						}
					}

					return toolResult(
						id,
						JSON.stringify({ query, totalMatches: matches.length, matches: matches.slice(0, 10) }, null, 2),
					);
				}

				case 'get_note': {
					let path = String(args.path ?? '').trim();
					if (!path) return toolResult(id, 'get_note requires a path argument', true);
					if (!path.endsWith('.md')) path = `${path}.md`;
					const content = await vault.getNote(path);
					if (content === null) return toolResult(id, `Note not found: ${path}`, true);
					return toolResult(id, content);
				}

				case 'curate_story': {
					const nativeId = String(args.native_id ?? '');
					const title = String(args.title ?? '');
					const url = String(args.url ?? '');
					if (!nativeId || !title || !url) {
						return toolResult(id, 'curate_story requires native_id, title, and url', true);
					}

					const topics = Array.isArray(args.topics) ? (args.topics as string[]) : ['General'];
					const concepts = Array.isArray(args.concepts) ? (args.concepts as string[]) : [];

					const story: OKFStoryNote = {
						schema_version: 'okf/v1',
						id: `hn-${nativeId}`,
						type: 'story',
						title,
						resource: url,
						source: 'hackernews',
						native_id: nativeId,
						timestamp: new Date().toISOString(),
						curator: 'curator',
						curator_model: liveModel(),
						significance_score: typeof args.significance_score === 'number' ? args.significance_score : 0.9,
						topics,
						concepts,
						tags: topics.map((t) => `#${t.toLowerCase().replace(/\s+/g, '-')}`),
						summary: String(args.summary ?? ''),
						significance: String(args.significance ?? ''),
						curatorNotes: String(args.curatorNotes ?? ''),
						discussionUrl: `https://news.ycombinator.com/item?id=${nativeId}`,
						by: args.by ? String(args.by) : undefined,
						score: typeof args.score === 'number' ? args.score : undefined,
					};

					const path = await vault.saveStoryNote(story);

					// If a Dot webhook is configured in env, notify asynchronously
					const dotWebhook = c.env?.DOT_WEBHOOK_URL as string | undefined;
					if (dotWebhook && story.significance_score >= 0.85) {
						c.executionCtx?.waitUntil?.(notifyDotWebhook(dotWebhook, story, path));
					}

					return toolResult(
						id,
						JSON.stringify(
							{
								status: 'curated',
								path,
								storyId: story.id,
								title: story.title,
								conceptsAdded: concepts.length,
								vaultIndexUpdated: true,
							},
							null,
							2,
						),
					);
				}

				case 'get_git_sync_info': {
					const artifacts = c.env?.ARTIFACTS as ArtifactsBinding | undefined;
					let cloneUrl = 'https://git.cloudflare.com/default/library-vault.git';
					if (artifacts) {
						try {
							const repo = await artifacts.get('library-vault');
							if (repo) cloneUrl = repo.httpUrl ?? repo.url ?? cloneUrl;
						} catch {
							// fallback
						}
					}
					const info: GitSyncInfo = {
						backend: 'cloudflare-artifacts',
						repository: 'library-vault',
						branch: 'main',
						cloneUrl,
						endpoints: {
							token: '/wiki/git/token',
							manifest: '/wiki/manifest',
						},
						instructions: {
							obsidianGit: [
								'1. Install Obsidian plugin: "Obsidian Git"',
								'2. Request a scoped token via POST /wiki/git/token',
								`3. Configure remote: ${cloneUrl}`,
								'4. Set automatic sync interval',
							],
							gitCli: [
								`git clone ${cloneUrl} library-vault`,
								'cd library-vault',
							],
						},
					};
					return toolResult(id, JSON.stringify(info, null, 2));
				}

				default:
					return rpcError(id, -32601, `Method not found: tool ${toolName}`);
			}
		}

		return rpcError(id, -32601, `Method not found: ${method}`);
	});

	return router;
}
