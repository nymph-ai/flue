/**
 * A stand-in for the Linear MCP server, in the isolate: a stateless
 * 2026-07-28 server (`createMcpHandler` answers `server/discover` and
 * `tools/list`) whose `tools/call` is answered here, over a fixed tracker of
 * open issues and their comments.
 *
 * - `list_issues({ team, state, limit })` → `{ issues }`
 * - `list_comments({ issueId })` → `{ comments }`
 *
 * Each result carries its value three ways: as JSON text, as
 * `structuredContent`, and spread at the top level of the `CallToolResult`
 * (MCP results may carry extra fields), so a script written against Pi's
 * Code Mode — where an MCP tool resolves to its whole `CallToolResult` — can
 * read `const { issues } = await tools.mcp__linear__list_issues(…)`, as
 * Earendil's "You Said No MCP!" script does.
 *
 * Every comment's tone is one of `none`, `mild` or `high`, so a classifier
 * stand-in can answer from the text alone. Imported only by tests.
 */
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

export type Tone = 'none' | 'mild' | 'high';

export interface LinearIssue {
	readonly identifier: string;
	readonly title: string;
	readonly state: string;
}

export interface LinearComment {
	readonly id: string;
	readonly body: string;
}

const TONES: Record<Tone, readonly string[]> = {
	none: ['Thanks, this works on my machine now.', 'Steps to reproduce are in the description.'],
	mild: ['[mild] This is the third time I am asking, a bit disappointing.'],
	high: ['[high] Seriously? This is broken AGAIN and nobody cares.'],
};

/** The tracker: `count` open issues; every fifth is mildly frustrated, every eleventh highly. */
export function linearTracker(count = 12): {
	readonly issues: readonly LinearIssue[];
	readonly comments: ReadonlyMap<string, readonly LinearComment[]>;
	readonly tones: ReadonlyMap<string, Tone>;
} {
	const issues: LinearIssue[] = [];
	const comments = new Map<string, LinearComment[]>();
	const tones = new Map<string, Tone>();
	for (let index = 1; index <= count; index++) {
		const identifier = `PI-${index}`;
		const tone: Tone = index % 11 === 0 ? 'high' : index % 5 === 0 ? 'mild' : 'none';
		issues.push({ identifier, title: `Issue ${index}`, state: 'open' });
		tones.set(identifier, tone);
		comments.set(
			identifier,
			TONES[tone].map((body, n) => ({ id: `${identifier}-c${n + 1}`, body })),
		);
	}
	return { issues, comments, tones };
}

const TOOLS = [
	{
		name: 'list_issues',
		description: 'List issues of a team.',
		inputSchema: {
			type: 'object',
			properties: {
				team: { type: 'string' },
				state: { type: 'string' },
				limit: { type: 'number' },
			},
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: 'list_comments',
		description: 'List the comments of an issue.',
		inputSchema: {
			type: 'object',
			properties: { issueId: { type: 'string' } },
			required: ['issueId'],
		},
		annotations: { readOnlyHint: true },
	},
];

/** The server's `fetch`, and the `tools/call` requests it answered. */
export function linearServer(tracker = linearTracker()) {
	const calls: { name: string; arguments: Record<string, unknown> }[] = [];
	const handler = createMcpHandler(
		() => {
			const server = new Server(
				{ name: 'linear', version: '1.0.0' },
				{ capabilities: { tools: {} }, instructions: 'The Linear issue tracker.' },
			);
			server.setRequestHandler('tools/list', (async () => ({ tools: TOOLS })) as never);
			return server;
		},
		{ legacy: 'reject', responseMode: 'json' },
	);
	const result = (id: unknown, value: Record<string, unknown>) =>
		Response.json({
			jsonrpc: '2.0',
			id,
			result: {
				resultType: 'complete',
				content: [{ type: 'text', text: JSON.stringify(value) }],
				structuredContent: value,
				...value,
			},
		});
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.method === 'POST') {
			const body = (await request.clone().json()) as {
				id?: unknown;
				method?: string;
				params?: { name?: string; arguments?: Record<string, unknown> };
			};
			if (body.method === 'tools/call') {
				const args = body.params?.arguments ?? {};
				calls.push({ name: String(body.params?.name), arguments: args });
				if (body.params?.name === 'list_issues') {
					const limit = typeof args.limit === 'number' ? args.limit : tracker.issues.length;
					return result(body.id, { issues: tracker.issues.slice(0, limit) });
				}
				if (body.params?.name === 'list_comments') {
					return result(body.id, {
						comments: tracker.comments.get(String(args.issueId)) ?? [],
					});
				}
				return Response.json({
					jsonrpc: '2.0',
					id: body.id,
					result: {
						resultType: 'complete',
						content: [{ type: 'text', text: `no such tool: ${String(body.params?.name)}` }],
						isError: true,
					},
				});
			}
		}
		return handler.fetch(request);
	}) as typeof globalThis.fetch;
	return { fetch, calls, tracker };
}
