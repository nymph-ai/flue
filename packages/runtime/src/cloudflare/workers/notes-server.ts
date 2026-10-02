/**
 * An MCP server in the isolate for the Code Mode workerd tests: a stateless
 * 2026-07-28 server (`createMcpHandler` answers `server/discover` and
 * `tools/list`) whose `tools/call` is answered here, over a fixed set of
 * notes. `list_notes()` → `{ notes }` (ids and titles), `get_note({ id })`
 * → `{ note }`, each as JSON text and as `structuredContent`. Every fifth
 * note reads `[mild]`, every eleventh `[high]`, for a classifier stand-in.
 * Imported only by tests.
 */
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

export type Tone = 'none' | 'mild' | 'high';

export interface Note {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly tone: Tone;
}

const BODIES: Record<Tone, string> = {
	none: 'Steps to reproduce are in the description.',
	mild: '[mild] Third time asking, a bit disappointing.',
	high: '[high] Broken AGAIN and nobody cares.',
};

/** `count` notes; every fifth is mild, every eleventh high. */
export function notes(count: number): readonly Note[] {
	return Array.from({ length: count }, (_, index) => {
		const n = index + 1;
		const tone: Tone = n % 11 === 0 ? 'high' : n % 5 === 0 ? 'mild' : 'none';
		return { id: `N-${n}`, title: `Note ${n}`, body: BODIES[tone], tone };
	});
}

const TOOLS = [
	{
		name: 'list_notes',
		description: 'List every note.',
		inputSchema: { type: 'object', properties: {} },
		annotations: { readOnlyHint: true },
	},
	{
		name: 'get_note',
		description: 'Read one note.',
		inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
		annotations: { readOnlyHint: true },
	},
];

/** The server's `fetch`, and the `tools/call` requests it answered. */
export function notesServer(all: readonly Note[]) {
	const calls: { name: string; arguments: Record<string, unknown> }[] = [];
	const handler = createMcpHandler(
		() => {
			const server = new Server(
				{ name: 'notes', version: '1.0.0' },
				{ capabilities: { tools: {} }, instructions: 'Notes for the Code Mode tests.' },
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
				if (body.params?.name === 'list_notes') {
					return result(body.id, { notes: all.map(({ id, title }) => ({ id, title })) });
				}
				const note = all.find((candidate) => candidate.id === args.id);
				return result(body.id, { note: note ? { id: note.id, body: note.body } : null });
			}
		}
		return handler.fetch(request);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}
