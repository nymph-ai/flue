/**
 * One Code Mode suite, run against every executor: the Node executor under
 * vitest (`codemode.test.ts`) and the Dynamic Worker executor inside workerd
 * (`codemode.workers.test.ts`). It drives the real `codemode` Pi tool over a
 * fake Pi tool API whose documents live in a Map, so persistence is observed
 * the way Pi stores it: through `snapshot` and `commit`.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Executor } from '@cloudflare/codemode';
import type {
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { type McpCallResult, registerMcpToolSource } from '../tool-adapter.ts';
import { CODEMODE_TOOL_NAME, createCodemodeToolRegistration } from './tool.ts';

const PIXEL =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const objectSchema = (properties: Record<string, unknown>) =>
	({ type: 'object', properties }) as unknown as ToolRegistration['parameters'];

/** A Pi tool API over one in-memory document store, as a conversation sees it. */
function fakeApi(documents: Map<string, unknown>, callId: string): ToolExecutionApi {
	const key = (token: { definition: { kind: string } }, conversationId: unknown) =>
		`${token.definition.kind}:${String(conversationId)}`;
	return {
		callId,
		conversationId: 1,
		output: () => {},
		diagnostic: () => {},
		details: async () => {},
		snapshot: async (token: { definition: { kind: string } }, conversationId: unknown) => {
			const value = documents.get(key(token, conversationId));
			return value === undefined ? undefined : structuredClone(value);
		},
		commit: async (change: (tx: unknown) => unknown) => {
			const drafts = new Map<string, unknown>();
			const tx = {
				doc: async (
					token: { definition: { kind: string; initial: () => unknown } },
					conversationId: unknown,
				) => {
					const id = key(token, conversationId);
					if (!drafts.has(id))
						drafts.set(id, structuredClone(documents.get(id) ?? token.definition.initial()));
					return drafts.get(id);
				},
			};
			const result = await change(tx);
			for (const [id, value] of drafts) documents.set(id, value);
			return result;
		},
	} as unknown as ToolExecutionApi;
}

/** A fake MCP server's tool: a Pi registration carrying its MCP source, like `mcp.ts` adapts one. */
function mcpTool(
	server: string,
	name: string,
	spec: {
		description: string;
		outputSchema?: object;
		result: (args: Record<string, unknown>) => McpCallResult;
	},
): ToolRegistration {
	const registration: ToolRegistration = {
		name: `mcp__${server}__${name}`,
		description: spec.description,
		parameters: objectSchema({ id: { type: 'string' } }),
		async execute() {
			throw new Error('direct calls are not part of this suite');
		},
	};
	registerMcpToolSource(registration, {
		server,
		instructions: `The ${server} server.`,
		tool: {
			name,
			description: spec.description,
			inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
			...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
		},
		call: async (args) => spec.result(args),
	});
	return registration;
}

/** 200 MCP tools on one server, one of them the needle. */
function largeCatalog(): ToolRegistration[] {
	const tools: ToolRegistration[] = [];
	for (let index = 0; index < 199; index++) {
		tools.push(
			mcpTool('crm', `list_widgets_${index}`, {
				description: `List widgets of shelf ${index}.`,
				result: () => ({ content: [{ type: 'text', text: `shelf ${index}` }] }),
			}),
		);
	}
	tools.push(
		mcpTool('crm', 'get_invoice_total', {
			description: 'Total amount due on an invoice, in cents.',
			outputSchema: {
				type: 'object',
				properties: { invoice: { type: 'string' }, cents: { type: 'number' } },
				required: ['invoice', 'cents'],
			},
			result: (args) => ({
				content: [{ type: 'text', text: '{"invoice":"x","cents":0}' }],
				structuredContent: { invoice: String(args.id), cents: 4200 },
			}),
		}),
	);
	return tools;
}

const greet: ToolRegistration = {
	name: 'greet-user',
	description: 'Greets someone.',
	parameters: objectSchema({ name: { type: 'string' } }),
	async execute(args) {
		return {
			content: [{ type: 'text', text: `hello ${String((args as { name: string }).name)}` }],
		};
	},
};

const greetUnderscore: ToolRegistration = {
	name: 'greet_user',
	description: 'Greets someone, differently.',
	parameters: objectSchema({ name: { type: 'string' } }),
	async execute(args) {
		return { content: [{ type: 'text', text: `hi ${String((args as { name: string }).name)}` }] };
	},
};

const camera = mcpTool('cam', 'snapshot', {
	description: 'Take a picture.',
	result: () => ({
		content: [
			{ type: 'text', text: 'a frame' },
			{ type: 'image', data: PIXEL, mimeType: 'image/png' },
		],
	}),
});

function textOf(result: ToolExecutionResult): string {
	return (result.content ?? [])
		.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
		.join('\n');
}

/** The suite, against one executor. */
export function defineCodemodeSuite(label: string, makeExecutor: () => Executor): void {
	describe(`Code Mode: ${label}`, () => {
		const run = async (
			tools: ToolRegistration[],
			code: string,
			documents = new Map<string, unknown>(),
			callId = 'call-1',
		) => {
			const tool = createCodemodeToolRegistration({ executor: makeExecutor(), tools });
			return tool.execute({ code }, fakeApi(documents, callId), BACKGROUND_CONTEXT);
		};

		it('describes the sandbox ABI and its namespaces, not every method', () => {
			const tool = createCodemodeToolRegistration({
				executor: makeExecutor(),
				tools: [greet, ...largeCatalog()],
			});
			expect(tool.name).toBe(CODEMODE_TOOL_NAME);
			expect(tool.replay).toBe('unsafe');
			expect(tool.description).toContain('codemode.search(query)');
			expect(tool.description).toContain('MCP server "crm", 200 methods');
			expect(tool.description).not.toContain('list_widgets_7');
		});

		it('searches and describes a 200-method catalog inside the sandbox', async () => {
			const result = await run(
				largeCatalog(),
				`async () => {
					const found = await codemode.search("invoice total");
					const docs = await codemode.describe(found.results[0].path);
					return { first: found.results[0].path, total: found.total, types: docs.types };
				}`,
			);
			expect(result.isError).toBeUndefined();
			const value = JSON.parse(textOf(result).split('\n').slice(1).join('\n'));
			expect(value.first).toBe('crm.get_invoice_total');
			expect(value.total).toBeGreaterThanOrEqual(1);
			expect(value.types).toContain('cents: number');
			expect(value.types).toContain('GetInvoiceTotalOutput');
		});

		it('returns typed structured content from MCP methods', async () => {
			const result = await run(
				largeCatalog(),
				`async () => {
					const total = await crm.get_invoice_total({ id: "inv-7" });
					return total.cents + 1;
				}`,
			);
			expect(textOf(result)).toMatch(/\n4201$/);
		});

		it('passes images through to the model', async () => {
			const result = await run([camera], 'async () => await cam.snapshot({})');
			expect(result.isError).toBeUndefined();
			expect(result.content).toContainEqual({ type: 'image', data: PIXEL, mimeType: 'image/png' });
			expect(textOf(result)).toContain('a frame');
		});

		it("calls the agent's own tools, keeping names that differ only by - and _ apart", async () => {
			const tool = createCodemodeToolRegistration({
				executor: makeExecutor(),
				tools: [greet, greetUnderscore],
			});
			const ids = [...tool.description.matchAll(/greet_user_[0-9a-f]{6}/g)].map(
				(match) => match[0],
			);
			expect(new Set(ids).size).toBe(2);
			const [first, second] = [...new Set(ids)] as [string, string];
			const result = await run(
				[greet, greetUnderscore],
				`async () => [await tools.${first}({ name: "a" }), await tools.${second}({ name: "b" })]`,
			);
			const value = JSON.parse(textOf(result).split('\n').slice(1).join('\n')) as string[];
			expect(value.some((entry) => entry.startsWith('hello'))).toBe(true);
			expect(value.some((entry) => entry.startsWith('hi'))).toBe(true);
		});

		it('keeps store() across calls in the conversation, and drops the writes of a failed script', async () => {
			const documents = new Map<string, unknown>();
			const first = await run(
				[greet],
				'async () => { await codemode.store("seen", { count: 1 }); return "ok"; }',
				documents,
				'call-1',
			);
			expect(first.isError).toBeUndefined();
			const failed = await run(
				[greet],
				'async () => { await codemode.store("seen", { count: 99 }); throw new Error("boom"); }',
				documents,
				'call-2',
			);
			expect(failed.isError).toBe(true);
			expect(textOf(failed)).toContain('boom');
			const second = await run(
				[greet],
				'async () => (await codemode.load("seen")).count + 1',
				documents,
				'call-3',
			);
			expect(textOf(second)).toMatch(/\n2$/);
		});

		it('reports a thrown error and the calls made before it', async () => {
			const result = await run(
				[greet],
				'async () => { await tools.greet_user({ name: "x" }); throw new Error("nope"); }',
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('nope');
			expect(textOf(result)).toContain('tools.greet_user');
		});

		it('has no network', async () => {
			const result = await run(
				[],
				'async () => { await fetch("https://example.com"); return "reached"; }',
			);
			expect(textOf(result)).not.toContain('reached');
		});
	});
}
