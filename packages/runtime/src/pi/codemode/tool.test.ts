import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { CODEMODE_SOURCE_GRAMMAR } from '@earendil-works/pi-codemode/source';
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable';
import { afterAll, describe, expect, it } from 'vitest';
import { NodeCodemodeExecutor } from '../../node/codemode-node.ts';
import type { CodemodeStoreWrites } from './executor.ts';
import { CODEMODE_TOOL_NAME, createCodemodeToolRegistration } from './tool.ts';

const objectSchema = (properties: Record<string, unknown>) =>
	({ type: 'object', properties }) as unknown as ToolRegistration['parameters'];

const seenCallIds: string[] = [];

const greet: ToolRegistration = {
	name: 'greet-user',
	description: 'Greets someone.',
	parameters: objectSchema({ name: { type: 'string' } }),
	async execute(args, api) {
		seenCallIds.push(api.callId);
		// Running output becomes the result text when `content` is omitted.
		api.output('hello ');
		api.output(String((args as { name: string }).name));
		return {};
	},
};

const refuse: ToolRegistration = {
	name: 'refuse',
	description: 'Always refuses.',
	parameters: objectSchema({}),
	async execute() {
		return { content: [{ type: 'text', text: 'refused' }], isError: true };
	},
};

const trimmed: ToolRegistration = {
	name: 'trimmed',
	description: 'Trims its input after argument repair.',
	parameters: objectSchema({ value: { type: 'string' } }),
	prepareArguments: (args) => ({ value: String((args as { value: unknown }).value).trim() }),
	async execute(args) {
		return { content: [{ type: 'text', text: `[${(args as { value: string }).value}]` }] };
	},
};

function fakeApi(callId: string): ToolExecutionApi {
	return {
		callId,
		output: () => {
			throw new Error('the codemode tool must not write running output');
		},
		diagnostic: () => {},
		details: async () => {},
	} as unknown as ToolExecutionApi;
}

function textOf(result: Awaited<ReturnType<ToolRegistration['execute']>>): string {
	return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('|');
}

describe('codemode ToolRegistration', () => {
	const executor = new NodeCodemodeExecutor();
	afterAll(() => executor.close());

	it("declares Pi's contract: description, declarations, source grammar", () => {
		const tool = createCodemodeToolRegistration({ executor, tools: [greet, refuse] });
		expect(tool.name).toBe(CODEMODE_TOOL_NAME);
		expect(tool.description).toContain('Run JavaScript code to orchestrate/compose tool calls');
		expect(tool.description).toContain('### `greet_user` (`greet-user`)');
		expect(tool.description).toContain('greet_user(args: { name?: string; }): Promise<string>;');
		expect(tool.constrainedSampling).toEqual({
			type: 'grammar',
			variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR },
		});
		expect(tool.replay).toBe('unsafe');
	});

	it('leaves itself out of the nested tools', () => {
		const self = createCodemodeToolRegistration({ executor, tools: [greet] });
		const tool = createCodemodeToolRegistration({ executor, tools: [greet, self] });
		expect(tool.description).not.toContain('### `codemode`');
	});

	it('runs nested tools and formats the result like Pi', async () => {
		const tool = createCodemodeToolRegistration({ executor, tools: [greet, refuse, trimmed] });
		const result = await tool.execute(
			{
				code: [
					'const a = await tools.greet_user({ name: "ada" });',
					'const b = await tools["greet-user"]({ name: "bob" });',
					'let refused;',
					'try { await tools.refuse({}); } catch (error) { refused = error.message; }',
					'text(a);',
					'return [b, refused, await tools.trimmed({ value: "  x  " })];',
				].join('\n'),
			},
			fakeApi('call-1'),
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toMatch(
			/^Script completed\nWall time \d+\.\d seconds\nOutput:\n\|hello ada\|\["hello bob","refused","\[x\]"\]$/,
		);
		expect(seenCallIds).toEqual(['call-1/1', 'call-1/2']);
		expect(result.details).toMatchObject({
			calls: [
				{ name: 'greet-user', status: 'ok' },
				{ name: 'greet-user', status: 'ok' },
				{ name: 'refuse', status: 'error' },
				{ name: 'trimmed', status: 'ok' },
			],
		});
	});

	it('reports a failed script with its partial output and the calls made', async () => {
		const tool = createCodemodeToolRegistration({ executor, tools: [greet] });
		const result = await tool.execute(
			{ code: 'text("partial");\nawait tools.greet_user({ name: "x" });\nthrow new Error("boom");' },
			fakeApi('call-2'),
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toMatch(/^Script failed\n/);
		expect(text).toContain('|partial|Script error:\nError: boom');
		expect(text).toContain('Tool calls made before the failure (they are not undone): greet-user (ok)');
	});

	it('honours the // @options: line and rejects a bad one', async () => {
		const tool = createCodemodeToolRegistration({ executor, tools: [] });
		const truncated = await tool.execute(
			{ code: '// @options: {"max_output_tokens": 5}\ntext("z".repeat(100));' },
			fakeApi('call-3'),
			BACKGROUND_CONTEXT,
		);
		expect(textOf(truncated)).toContain('Warning: truncated output (original token count: 25)');

		const invalid = await tool.execute(
			{ code: '// @options: {"bogus": 1}\nreturn 1;' },
			fakeApi('call-4'),
			BACKGROUND_CONTEXT,
		);
		expect(invalid.isError).toBe(true);
		expect(textOf(invalid)).toMatch(/bogus/);
	});

	it('loads the store before a script and saves writes after a successful one', async () => {
		const saved: CodemodeStoreWrites[] = [];
		const tool = createCodemodeToolRegistration({
			executor,
			tools: [],
			store: {
				load: async () => ({ runs: 2 }),
				save: async (writes) => {
					saved.push(writes);
				},
			},
		});
		const result = await tool.execute(
			{ code: 'store("runs", load("runs") + 1);\nreturn load("runs");' },
			fakeApi('call-5'),
			BACKGROUND_CONTEXT,
		);
		expect(textOf(result)).toMatch(/\|3$/);
		expect(saved).toEqual([{ set: { runs: 3 }, delete: [] }]);

		await tool.execute({ code: 'store("runs", 9);\nthrow new Error("no");' }, fakeApi('call-6'), BACKGROUND_CONTEXT);
		expect(saved).toHaveLength(1);
	});
});
