/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Code Mode inside workerd: the real `codemode` Pi tool running Pi's QuickJS
 * sandbox in-process in a stand-in agent's Durable Object
 * (`workers/test-worker.ts`), with QuickJS imported as a compiled module the
 * way the generated Worker entry imports it. The Pi tool API is a fake whose
 * documents live in a Map, so `store()` and the journal of a parked script
 * are observed the way Pi stores them: through `snapshot` and `commit`.
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
import { runWithCloudflareContext } from '../cloudflare/context.ts';
import { FlueQuestionCall, FlueQuestions } from '../pi/questions.ts';
import {
	type FlueAnswer,
	type FlueQuestion,
	QuestionParkedError,
	setQuestionHandler,
} from '../questions.ts';
import { type McpCallResult, registerMcpToolSource } from '../tool-adapter.ts';
import {
	CODEMODE_TOOL_NAME,
	type CodemodeToolOptions,
	createCodemodeToolRegistration,
	resumeCodemodeQuestion,
} from './tool.ts';

const PIXEL =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type TestEnv = { AGENT: DurableObjectNamespace };
const testEnv = env as unknown as TestEnv;

const objectSchema = (properties: Record<string, unknown>) =>
	({ type: 'object', properties }) as unknown as ToolRegistration['parameters'];

/** A Pi tool API over one in-memory document store, as a conversation sees it. */
function fakeApi(documents: Map<string, unknown>, callId: string): ToolExecutionApi {
	const key = (token: { definition: { kind: string } }, conversationId: unknown) =>
		`${token.definition.kind}:${String(conversationId)}`;
	return {
		callId,
		// One tool task per call: the codemode tool keeps a task-scoped record of
		// the call (`pi/questions.ts` FlueQuestionCall).
		taskId: callId,
		conversationId: 1,
		env: undefined,
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

/** A tool that only counts its calls: the effect a rerun must not repeat. */
function counter(name: string) {
	const state = { calls: 0 };
	const tool: ToolRegistration = {
		name,
		description: `Count ${name} calls.`,
		parameters: objectSchema({}),
		async execute() {
			state.calls++;
			return { content: [{ type: 'text', text: `${name} #${state.calls}` }] };
		},
	};
	return { state, tool };
}

function textOf(result: ToolExecutionResult): string {
	return (result.content ?? [])
		.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
		.join('\n');
}

/** The output after Pi's result header (`Script completed` … `Output:`). */
function outputOf(result: ToolExecutionResult): string {
	return textOf(result).split('Output:\n').slice(1).join('Output:\n').trim();
}

function detailsOf(result: ToolExecutionResult) {
	return result.details as { executionId: string; status: string; questionId?: string };
}

let agentCount = 0;

/** A fresh stand-in agent: scripts run inside its Durable Object. */
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

describe("Pi's Code Mode in a Durable Object (QuickJS in-process)", () => {
	it("describes Pi's surface: helpers, the models API, and the tools' declarations", async () => {
		const { inside } = agent();
		const tool = await inside(async () =>
			createCodemodeToolRegistration({ tools: [greet, ...largeCatalog()] }),
		);
		expect(tool.name).toBe(CODEMODE_TOOL_NAME);
		// Rerun only to continue a parked question; any other rerun settles as interrupted.
		expect(tool.replay).toBe('safe');
		for (const phrase of [
			'await tools.read(...)',
			'searchTools(query: string',
			'describeNamespace(name: string)',
			'store(key: string, value: any)',
			'Model API:',
			'classify(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>',
			'## mcp__crm (some tools not listed)',
			'### `greet_user` (`greet-user`)',
		]) {
			expect(tool.description).toContain(phrase);
		}
		// Pi's 3000-token budget lists some of the 200 tools, not all.
		expect(tool.description).not.toContain('list_widgets_198');
	});

	it('finds a tool in a 200-tool catalog with searchTools() and describeTool()', async () => {
		const { run } = agent();
		const result = await run(
			{ tools: largeCatalog() },
			`const found = await searchTools("invoice total");
			const docs = await describeTool(found[0].name);
			return { first: found[0].name, all: ALL_TOOLS.length, typed: docs.includes("cents: number") };`,
		);
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(outputOf(result))).toEqual({
			first: 'mcp__crm__get_invoice_total',
			all: 200,
			typed: true,
		});
	});

	it("resolves an MCP tool to its CallToolResult, Pi's way", async () => {
		const { run } = agent();
		const result = await run(
			{ tools: largeCatalog() },
			`const total = await tools.mcp__crm__get_invoice_total({ id: "inv-7" });
			return [total.structuredContent.cents + 1, total.content[0].type, "_meta" in total];`,
		);
		expect(outputOf(result)).toBe('[4201,"text",false]');
	});

	it('passes images through image()', async () => {
		const { run } = agent();
		const result = await run(
			{ tools: [camera] },
			'const shot = await tools.mcp__cam__snapshot({}); text(shot.content[0].text); image(shot.content[1]);',
		);
		expect(result.isError).toBeUndefined();
		expect(result.content).toContainEqual({ type: 'image', data: PIXEL, mimeType: 'image/png' });
		expect(textOf(result)).toContain('a frame');
	});

	it("calls the agent's own tools by identifier and by name", async () => {
		const { run } = agent();
		const result = await run(
			{ tools: [greet] },
			'return [await tools.greet_user({ name: "a" }), await tools["greet-user"]({ name: "b" })];',
		);
		expect(outputOf(result)).toBe('["hello a","hello b"]');
	});

	it('keeps store() across calls in the conversation, and drops the writes of a failed script', async () => {
		const { run } = agent();
		const first = await run({ tools: [greet] }, 'store("seen", { count: 1 }); return "ok";');
		expect(first.isError).toBeUndefined();
		const failed = await run(
			{ tools: [greet] },
			'store("seen", { count: 99 }); throw new Error("boom");',
		);
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain('boom');
		const second = await run({ tools: [greet] }, 'return load("seen").count + 1;');
		expect(outputOf(second)).toBe('2');
	});

	it('has no network, no timers and no host globals', async () => {
		const { run } = agent();
		const result = await run(
			{ tools: [] },
			'return [typeof fetch, typeof setTimeout, typeof process, typeof WebAssembly];',
		);
		expect(outputOf(result)).toBe('["undefined","undefined","undefined","undefined"]');
	});

	it('stops a script that spins, within its CPU budget', async () => {
		const { run } = agent();
		const result = await run({ tools: [] }, 'while (true) {}');
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('CPU budget');
	});

	it('fails a script that outgrows its memory limit, inside the script', async () => {
		const { run } = agent();
		const result = await run(
			{ tools: [], memoryLimitBytes: 8 * 1024 * 1024 },
			'const a = []; while (true) a.push("x".repeat(1024));',
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('out of memory');
	});

	it('asks before a tool that requires approval, and runs it once approved', async () => {
		const ops = opsServer();
		const asked: FlueQuestion[] = [];
		setQuestionHandler(async (question): Promise<FlueAnswer> => {
			asked.push(question);
			return { kind: 'codemode-approval', decision: 'approve' };
		});
		const { run } = agent();
		const result = await run(
			{ tools: [ops.tool], requiresApproval: ['mcp__ops__deploy'] },
			'const done = await tools.mcp__ops__deploy({ id: "b-0" }); return done.content[0].text;',
		);
		expect(result.isError).toBeUndefined();
		expect(outputOf(result)).toBe('deployed b-0');
		expect(ops.deployed).toEqual(['b-0']);
		expect(asked).toHaveLength(1);
		const question = asked[0];
		if (question?.kind !== 'codemode-approval') throw new Error('expected an approval question');
		expect(question.pending).toEqual([
			expect.objectContaining({
				connector: 'tools',
				method: 'mcp__ops__deploy',
				args: { id: 'b-0' },
			}),
		]);
		expect(question.id).toMatch(new RegExp(`^codemode:${question.executionId}:[0-9a-f]{12}$`));
		expect(question.callId).toMatch(/^call-/);
	});

	it('gates tools by a predicate over MCP annotations', async () => {
		const ops = opsServer();
		const { run } = agent();
		const result = await run(
			{
				tools: [ops.tool],
				requiresApproval: (method) => method.annotations?.destructiveHint === true,
			},
			'await tools.mcp__ops__deploy({ id: "b-1" });',
		);
		// Not wired: refused, and never executed.
		expect(result.isError).toBe(true);
		expect(ops.deployed).toEqual([]);
	});

	it('refuses clearly while questions are not wired', async () => {
		const ops = opsServer();
		const { run } = agent();
		const result = await run(
			{ tools: [ops.tool], requiresApproval: ['mcp__ops__*'] },
			'await tools.mcp__ops__deploy({ id: "b-1" });',
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('tools.mcp__ops__deploy');
		expect(textOf(result)).toContain('questions are not wired');
		expect(ops.deployed).toEqual([]);
	});

	it('rejects the call inside the script when the approval is rejected', async () => {
		const ops = opsServer();
		setQuestionHandler(async () => ({
			kind: 'codemode-approval',
			decision: 'reject',
			reason: 'not on a Friday',
		}));
		const { run } = agent();
		const result = await run(
			{ tools: [ops.tool], requiresApproval: ['mcp__ops__deploy'] },
			'try { await tools.mcp__ops__deploy({ id: "b-2" }); } catch (error) { return "caught: " + error.message; }',
		);
		expect(result.isError).toBeUndefined();
		expect(outputOf(result)).toContain('rejected: not on a Friday');
		expect(ops.deployed).toEqual([]);
	});

	it('parks durably: after an eviction the script runs again over its journal, the parked call once', async () => {
		const ops = opsServer();
		const note = counter('note');
		let parked: FlueQuestion | undefined;
		setQuestionHandler(async (question) => {
			parked = question;
			throw new QuestionParkedError(question);
		});
		const { stub, inside, documents } = agent();
		const options: CodemodeToolOptions = {
			tools: [note.tool, ops.tool],
			requiresApproval: ['mcp__ops__deploy'],
		};
		const code =
			'const before = await tools.note({}); store("last", "b-3"); const done = await tools.mcp__ops__deploy({ id: "b-3" }); return [before, done.content[0].text];';
		const first = await inside(async () =>
			createCodemodeToolRegistration(options).execute(
				{ code },
				fakeApi(documents, 'call-park'),
				BACKGROUND_CONTEXT,
			),
		);
		expect(first.isError).toBeUndefined();
		expect(detailsOf(first).status).toBe('parked');
		expect(textOf(first)).toContain('tools.mcp__ops__deploy needs approval');
		expect(ops.deployed).toEqual([]);
		expect(note.state.calls).toBe(1);
		if (parked?.kind !== 'codemode-approval') throw new Error('expected a parked approval');
		const question = parked;
		expect(detailsOf(first).questionId).toBe(question.id);

		await evictDurableObject(stub);

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
		expect(outputOf(resumed)).toBe('["note #1","deployed b-3"]');
		// The journaled call was answered from the journal; the approved one ran once.
		expect(note.state.calls).toBe(1);
		expect(ops.deployed).toEqual(['b-3']);
		// The continued run's store() writes were kept.
		expect([...documents.values()]).toContainEqual({ values: { last: 'b-3' } });
	});

	it('continues a parked call when Pi reruns it, answering the earlier calls from the journal', async () => {
		const ops = opsServer();
		const note = counter('note');
		const { inside, documents } = agent();
		const api = fakeApi(documents, 'call-rerun');
		// The first run parks the way the entity handler does when its instance
		// goes away: the question and the call record stay, the call ends.
		setQuestionHandler(async (question) => {
			await api.commit(async (tx) => {
				const record = await tx.doc(FlueQuestions, question.id, null);
				record.status = 'parked';
				record.question = JSON.parse(JSON.stringify(question));
				const call = await tx.doc(FlueQuestionCall, api.taskId);
				call.started = true;
				call.question = question.id;
			}, BACKGROUND_CONTEXT);
			throw new QuestionParkedError(question);
		});
		const options: CodemodeToolOptions = {
			tools: [note.tool, ops.tool],
			requiresApproval: ['mcp__ops__deploy'],
		};
		const code =
			'const [a, b] = await Promise.all([tools.note({}), tools.note({})]); const done = await tools.mcp__ops__deploy({ id: "c-0" }); return [a, b, done.content[0].text];';
		const first = await inside(async () =>
			createCodemodeToolRegistration(options).execute({ code }, api, BACKGROUND_CONTEXT),
		);
		expect(detailsOf(first).status).toBe('parked');
		expect(note.state.calls).toBe(2);
		// The answer arrives; Pi reruns the same tool task.
		setQuestionHandler(async () => ({ kind: 'codemode-approval', decision: 'approve' }));
		const rerun = await inside(async () =>
			createCodemodeToolRegistration(options).execute({ code }, api, BACKGROUND_CONTEXT),
		);
		expect(rerun.isError).toBeUndefined();
		expect(outputOf(rerun)).toBe('["note #1","note #2","deployed c-0"]');
		expect(note.state.calls).toBe(2);
		expect(ops.deployed).toEqual(['c-0']);
	});

	it('a rerun of a call that never parked settles as interrupted instead of running the script again', async () => {
		const ops = opsServer();
		const { inside, documents } = agent();
		const options: CodemodeToolOptions = { tools: [ops.tool] };
		const code = 'return (await tools.mcp__ops__deploy({ id: "c-1" })).content[0].text;';
		const api = fakeApi(documents, 'call-once');
		const first = await inside(async () =>
			createCodemodeToolRegistration(options).execute({ code }, api, BACKGROUND_CONTEXT),
		);
		expect(first.isError).toBeUndefined();
		expect(ops.deployed).toEqual(['c-1']);
		// Pi reruns the same tool task (the same api): the call already started.
		const rerun = await inside(async () =>
			createCodemodeToolRegistration(options).execute({ code }, api, BACKGROUND_CONTEXT),
		);
		expect(rerun.isError).toBe(true);
		expect(textOf(rerun)).toContain('interrupted');
		expect(ops.deployed).toEqual(['c-1']);
	});
});
