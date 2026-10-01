/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Code Mode inside workerd: the real `codemode` Pi tool over
 * `@cloudflare/codemode`'s runtime, whose state lives in a Durable Object
 * Facet of a stand-in agent (`workers/test-worker.ts`), with scripts in
 * Dynamic Workers over Miniflare's Worker Loader. The Pi tool API is a fake
 * whose documents live in a Map, so `codemode.store()` is observed the way
 * Pi stores it: through `snapshot` and `commit`.
 */

import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from '@earendil-works/pi-durable';
import { afterEach, describe, expect, it } from 'vitest';
import { codemodeRuntime } from '../cloudflare/codemode.ts';
import { runWithCloudflareContext } from '../cloudflare/context.ts';
import {
	type FlueAnswer,
	type FlueQuestion,
	QuestionParkedError,
	setQuestionHandler,
} from '../questions.ts';
import { type McpCallResult, registerMcpToolSource } from '../tool-adapter.ts';
import { CODEMODE_TOOL_NAME, type CodemodeToolOptions, createCodemodeToolRegistration, resumeCodemodeQuestion } from './tool.ts';

const PIXEL =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type TestEnv = { AGENT: DurableObjectNamespace; LOADER: WorkerLoader };
const testEnv = env as unknown as TestEnv;

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
		annotations?: { destructiveHint?: boolean };
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
			...(spec.annotations ? { annotations: spec.annotations } : {}),
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

/** An MCP server with one destructive method, counting its real executions. */
function opsServer() {
	const deployed: unknown[] = [];
	const tool = mcpTool('ops', 'deploy', {
		description: 'Deploy a build to production.',
		annotations: { destructiveHint: true },
		result: (args) => {
			deployed.push(args.id);
			return { content: [{ type: 'text', text: `deployed ${String(args.id)}` }] };
		},
	});
	return { deployed, tool };
}

function textOf(result: ToolExecutionResult): string {
	return (result.content ?? [])
		.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
		.join('\n');
}

/** The script's value, from a completed result's second block. */
function scriptValue(result: ToolExecutionResult): unknown {
	return JSON.parse(textOf(result).split('\n').slice(1).join('\n'));
}

function detailsOf(result: ToolExecutionResult) {
	return result.details as { executionId: string; status: string; questionId?: string };
}

let agentCount = 0;

/** A fresh stand-in agent: its own Durable Object, so its own runtime facet. */
function agent() {
	const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(`agent-${++agentCount}`));
	/** Run `fn` inside the agent, with the Cloudflare context the coordinator establishes. */
	const inside = <T>(fn: () => Promise<T>) =>
		runInDurableObject(stub, (_instance, state) =>
			runWithCloudflareContext(
				{
					env: env as unknown as Record<string, unknown>,
					storage: state.storage,
					durableObjectState: state,
				},
				fn,
			),
		);
	const documents = new Map<string, unknown>();
	let calls = 0;
	const run = (options: CodemodeToolOptions, code: string) =>
		inside(async () => {
			const tool = createCodemodeToolRegistration(options);
			return tool.execute({ code }, fakeApi(documents, `call-${++calls}`), BACKGROUND_CONTEXT);
		});
	return { stub, inside, run, documents };
}

afterEach(() => setQuestionHandler(undefined));

describe('Code Mode on @cloudflare/codemode (Durable Object Facet + Dynamic Workers)', () => {
	it('describes the sandbox ABI and its namespaces, not every method', async () => {
		const { inside } = agent();
		const tool = await inside(async () =>
			createCodemodeToolRegistration({ tools: [greet, ...largeCatalog()] }),
		);
		expect(tool.name).toBe(CODEMODE_TOOL_NAME);
		expect(tool.replay).toBe('unsafe');
		for (const phrase of ['codemode.search(', 'codemode.describe(', 'codemode.step(', 'codemode.run(']) {
			expect(tool.description).toContain(phrase);
		}
		expect(tool.description).toContain('MCP server "crm", 200 methods');
		expect(tool.description).not.toContain('list_widgets_7');
	});

	it("searches and describes a 200-method catalog with the runtime's own codemode.search/describe", async () => {
		const { run } = agent();
		const result = await run(
			{ tools: largeCatalog() },
			`async () => {
				const found = await codemode.search("invoice total");
				const docs = await codemode.describe(found.results[0].path);
				return { first: found.results[0].path, total: found.total, types: docs.types };
			}`,
		);
		expect(result.isError).toBeUndefined();
		const value = scriptValue(result) as { first: string; total: number; types: string };
		expect(value.first).toBe('crm.get_invoice_total');
		expect(value.total).toBeGreaterThanOrEqual(1);
		expect(value.types).toContain('cents: number');
	});

	it('returns typed structured content from MCP methods', async () => {
		const { run } = agent();
		const result = await run(
			{ tools: largeCatalog() },
			`async () => {
				const total = await crm.get_invoice_total({ id: "inv-7" });
				return total.cents + 1;
			}`,
		);
		expect(textOf(result)).toMatch(/\n4201$/);
	});

	it('passes images through to the model', async () => {
		const { run } = agent();
		const result = await run({ tools: [camera] }, 'async () => await cam.snapshot({})');
		expect(result.isError).toBeUndefined();
		expect(result.content).toContainEqual({ type: 'image', data: PIXEL, mimeType: 'image/png' });
		expect(textOf(result)).toContain('a frame');
	});

	it("calls the agent's own tools, keeping names that differ only by - and _ apart", async () => {
		const { inside, run } = agent();
		const tool = await inside(async () =>
			createCodemodeToolRegistration({ tools: [greet, greetUnderscore] }),
		);
		const ids = [...new Set([...tool.description.matchAll(/greet_user_[0-9a-f]{6}/g)].map((m) => m[0]))];
		expect(ids).toHaveLength(2);
		const [first, second] = ids as [string, string];
		const result = await run(
			{ tools: [greet, greetUnderscore] },
			`async () => [await tools.${first}({ name: "a" }), await tools.${second}({ name: "b" })]`,
		);
		const value = scriptValue(result) as string[];
		expect(value.some((entry) => entry.startsWith('hello'))).toBe(true);
		expect(value.some((entry) => entry.startsWith('hi'))).toBe(true);
	});

	it('keeps store() across calls in the conversation, and drops the writes of a failed script', async () => {
		const { run } = agent();
		const first = await run(
			{ tools: [greet] },
			'async () => { await codemode.store("seen", { count: 1 }); return "ok"; }',
		);
		expect(first.isError).toBeUndefined();
		const failed = await run(
			{ tools: [greet] },
			'async () => { await codemode.store("seen", { count: 99 }); throw new Error("boom"); }',
		);
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain('boom');
		const second = await run({ tools: [greet] }, 'async () => (await codemode.load("seen")).count + 1');
		expect(textOf(second)).toMatch(/\n2$/);
	});

	it('has no network', async () => {
		const { run } = agent();
		const result = await run(
			{ tools: [] },
			'async () => { await fetch("https://example.com"); return "reached"; }',
		);
		expect(textOf(result)).not.toContain('reached');
	});

	it('pauses at a method that requires approval, and continues by replay once approved', async () => {
		const ops = opsServer();
		const asked: FlueQuestion[] = [];
		setQuestionHandler(async (question): Promise<FlueAnswer> => {
			asked.push(question);
			return { kind: 'codemode-approval', decision: 'approve' };
		});
		const { run } = agent();
		const result = await run(
			{ tools: [ops.tool], requiresApproval: ['ops.deploy'] },
			`async () => {
				const id = await codemode.step("build-id", () => crypto.randomUUID());
				const done = await ops.deploy({ id });
				return { id, done };
			}`,
		);
		expect(result.isError).toBeUndefined();
		const value = scriptValue(result) as { id: string; done: string };
		// The step ran once: the replayed run saw the same id, and deployed it once.
		expect(ops.deployed).toEqual([value.id]);
		expect(value.done).toBe(`deployed ${value.id}`);
		expect(asked).toHaveLength(1);
		const question = asked[0];
		if (question?.kind !== 'codemode-approval') throw new Error('expected an approval question');
		expect(question.runtime).toBe('flue');
		expect(question.pending).toEqual([
			expect.objectContaining({ connector: 'ops', method: 'deploy', args: { id: value.id } }),
		]);
		expect(question.id).toBe(
			`codemode:flue:${question.executionId}:${question.pending.map((action) => action.seq).join(',')}`,
		);
		expect(question.callId).toMatch(/^call-/);
	});

	it('gates methods by a predicate over MCP annotations', async () => {
		const ops = opsServer();
		const { run } = agent();
		const result = await run(
			{ tools: [ops.tool], requiresApproval: (method) => method.annotations?.destructiveHint === true },
			'async () => await ops.deploy({ id: "b-1" })',
		);
		// Not wired: refused, and never executed.
		expect(result.isError).toBe(true);
		expect(ops.deployed).toEqual([]);
	});

	it('refuses clearly while questions are not wired, ending the execution', async () => {
		const ops = opsServer();
		const { run, inside } = agent();
		const result = await run(
			{ tools: [ops.tool], requiresApproval: ['ops.*'] },
			'async () => await ops.deploy({ id: "b-1" })',
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('ops.deploy');
		expect(textOf(result)).toContain('questions are not wired');
		expect(ops.deployed).toEqual([]);
		// Nothing is left paused in the facet.
		expect(await inside(() => codemodeRuntime().pending())).toEqual([]);
	});

	it('ends the execution when the approval is rejected', async () => {
		const ops = opsServer();
		setQuestionHandler(async () => ({
			kind: 'codemode-approval',
			decision: 'reject',
			reason: 'not on a Friday',
		}));
		const { run } = agent();
		const result = await run(
			{ tools: [ops.tool], requiresApproval: ['ops.deploy'] },
			'async () => await ops.deploy({ id: "b-2" })',
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('rejected: not on a Friday');
		expect(ops.deployed).toEqual([]);
	});

	it('parks durably: the execution survives an eviction and resumes with the answer', async () => {
		const ops = opsServer();
		let parked: FlueQuestion | undefined;
		setQuestionHandler(async (question) => {
			parked = question;
			throw new QuestionParkedError(question);
		});
		const { stub, inside, documents } = agent();
		const options: CodemodeToolOptions = { tools: [ops.tool], requiresApproval: ['ops.deploy'] };
		const first = await inside(async () =>
			createCodemodeToolRegistration(options).execute(
				{
					code: 'async () => { await codemode.store("last", "b-3"); return await ops.deploy({ id: "b-3" }); }',
				},
				fakeApi(documents, 'call-park'),
				BACKGROUND_CONTEXT,
			),
		);
		expect(first.isError).toBeUndefined();
		expect(detailsOf(first).status).toBe('parked');
		expect(textOf(first)).toContain('ops.deploy needs approval');
		expect(ops.deployed).toEqual([]);
		if (parked?.kind !== 'codemode-approval') throw new Error('expected a parked approval');
		const question = parked;
		expect(detailsOf(first).questionId).toBe(question.id);

		await evictDurableObject(stub);

		const pending = await inside(() => codemodeRuntime().pending());
		expect(pending).toEqual([expect.objectContaining({ executionId: question.executionId, method: 'deploy' })]);
		const resumed = await inside(async () =>
			resumeCodemodeQuestion(
				createCodemodeToolRegistration(options),
				question,
				{ kind: 'codemode-approval', decision: 'approve' },
				fakeApi(documents, 'call-resume'),
				BACKGROUND_CONTEXT,
			),
		);
		expect(resumed.isError).toBeUndefined();
		expect(textOf(resumed)).toContain('deployed b-3');
		expect(ops.deployed).toEqual(['b-3']);
		// The resumed run's store() writes were kept.
		expect([...documents.values()]).toContainEqual({ values: { last: 'b-3' } });
	});

	it('runs a snippet the developer saved from an earlier execution', async () => {
		const { run, inside } = agent();
		const first = await run(
			{ tools: [greet] },
			'async (input) => await tools.greet_user({ name: input?.name ?? "nobody" })',
		);
		expect(first.isError).toBeUndefined();
		await inside(() =>
			codemodeRuntime().saveSnippet('greet-someone', {
				executionId: detailsOf(first).executionId,
				description: 'Greet a person by name.',
			}),
		);
		const second = await run(
			{ tools: [greet] },
			`async () => {
				const found = await codemode.search("greet a person");
				const ran = await codemode.run("greet-someone", { name: "Ada" });
				return { snippet: found.results.some((r) => r.kind === "snippet" && r.path === "greet-someone"), ran };
			}`,
		);
		expect(second.isError).toBeUndefined();
		expect(scriptValue(second)).toEqual({ snippet: true, ran: 'hello Ada' });
	});
});
