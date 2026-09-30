/**
 * The Code Mode conformance corpus: scripts and the `CodemodeResult` Pi's
 * `CodemodeSandbox` (QuickJS) produces for each. The Node executor runs it in
 * `node.test.ts` — that is what pins these expectations to Pi — and the
 * Dynamic Worker executor runs the same corpus in
 * `dynamic-worker.workers.test.ts` (inside workerd) and in
 * `cloudflare/codemode-dynamic-worker.test.ts` (on a Node stand-in for the
 * Worker Loader), so a Flue executor that drifts from Pi's script ABI fails a
 * test (PI_UPGRADE_PLAN.md §5).
 *
 * Results are compared after {@link normalizeResult}: call durations and
 * stack traces are engine timing and engine text, and so are the messages of
 * errors the engine itself raises (a syntax error), which a case marks with
 * `engineMessage`.
 */
import type {
	CodemodeExecutor,
	CodemodeOutputItem,
	CodemodeResult,
	CodemodeStoreWrites,
	CodemodeTool,
	CodemodeToolContext,
} from '../executor.ts';

/** A 1×1 PNG. */
const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Resolves only when the call is cancelled: the script ended, timed out, or was aborted. */
function untilCancelled(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(new Error('cancelled'));
		signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
	});
}

/** The tools every case sees, in this order (`ALL_TOOLS` follows it). */
export const CONFORMANCE_TOOLS: readonly CodemodeTool[] = [
	{
		name: 'add',
		description: 'Adds two numbers.',
		execute: (args) => {
			const { a, b } = args as { a: number; b: number };
			return a + b;
		},
	},
	{
		name: 'fail',
		description: 'Always fails.',
		execute: () => {
			throw new Error('nope');
		},
	},
	{ name: 'echo', description: 'Returns its argument.', execute: (args) => args },
	{ name: 'my-tool', description: 'A tool with a dash in its name.', execute: () => 'mine' },
	{
		name: 'slow',
		description: 'Never finishes on its own.',
		execute: (_args, { signal }) => untilCancelled(signal),
	},
];

export const CONFORMANCE_GLOBALS: readonly CodemodeTool[] = [
	{
		name: 'sum',
		spread: true,
		execute: (args) => (args as number[]).reduce((total, value) => total + value, 0),
	},
];

export type NormalizedResult =
	| {
			readonly ok: true;
			readonly value: unknown;
			readonly output: readonly CodemodeOutputItem[];
			readonly calls: readonly { name: string; status: string }[];
			readonly storeWrites: CodemodeStoreWrites;
	  }
	| {
			readonly ok: false;
			readonly error: { kind: string; name?: string; message?: string };
			readonly output: readonly CodemodeOutputItem[];
			readonly calls: readonly { name: string; status: string }[];
	  };

export interface ConformanceCase {
	readonly name: string;
	readonly code: string;
	readonly store?: Record<string, unknown>;
	/** Default 10 s: every case settles well before it unless it is about the deadline. */
	readonly timeoutMs?: number;
	/**
	 * Abort the execution with `new Error('stop')` once this tool has been
	 * called — not after a fixed delay, which would race the sandbox start.
	 */
	readonly abortOnCall?: string;
	/** The error message is the engine's own text; compare kind and name only. */
	readonly engineMessage?: boolean;
	/** Why an executor cannot run this case, by executor. */
	readonly skip?: { readonly dynamicWorker?: string };
	readonly expected: NormalizedResult;
}

const NO_WRITES: CodemodeStoreWrites = { set: {}, delete: [] };
const text = (value: string): CodemodeOutputItem => ({ type: 'text', text: value });

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
	{
		name: 'returns a value',
		code: 'return 1 + 2;',
		expected: { ok: true, value: 3, output: [], calls: [], storeWrites: NO_WRITES },
	},
	{
		name: 'text() and console.* append text items',
		code: [
			'text("a");',
			'text(42);',
			'text({ x: 1 });',
			'text(null);',
			'text(undefined);',
			'console.log("b", { y: 2 }, 3);',
			'console.warn("w");',
			'return "done";',
		].join('\n'),
		expected: {
			ok: true,
			value: 'done',
			output: [
				text('a'),
				text('42'),
				text('{"x":1}'),
				text('null'),
				text('undefined'),
				text('b {"y":2} 3'),
				text('w'),
			],
			calls: [],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'calls a tool and records the call',
		code: 'const sum = await tools.add({ a: 2, b: 3 });\ntext("sum " + sum);\nreturn sum;',
		expected: {
			ok: true,
			value: 5,
			output: [text('sum 5')],
			calls: [{ name: 'add', status: 'ok' }],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'exposes tool names as identifiers and lists ALL_TOOLS',
		code: [
			'const byId = await tools.my_tool({});',
			'const byName = await tools["my-tool"]({});',
			'const entry = ALL_TOOLS.find((tool) => tool.name === "my_tool");',
			'return [byId, byName, ALL_TOOLS.map((tool) => tool.name), entry.description, Object.isFrozen(ALL_TOOLS)];',
		].join('\n'),
		expected: {
			ok: true,
			value: [
				'mine',
				'mine',
				['add', 'fail', 'echo', 'my_tool', 'slow'],
				'A tool with a dash in its name.',
				true,
			],
			output: [],
			calls: [
				{ name: 'my-tool', status: 'ok' },
				{ name: 'my-tool', status: 'ok' },
			],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'a failing tool rejects with its message',
		code: 'try {\n  await tools.fail({});\n} catch (error) {\n  text(error.name + ": " + error.message);\n}\nreturn "handled";',
		expected: {
			ok: true,
			value: 'handled',
			output: [text('Error: nope')],
			calls: [{ name: 'fail', status: 'error' }],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'arguments and results make a JSON round trip',
		code: 'return await tools.echo({ date: new Date(0), missing: undefined, list: [1, undefined] });',
		expected: {
			ok: true,
			value: { date: '1970-01-01T00:00:00.000Z', list: [1, null] },
			output: [],
			calls: [{ name: 'echo', status: 'ok' }],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'runs tool calls in parallel',
		code: 'return await Promise.all([tools.add({ a: 1, b: 1 }), tools.add({ a: 2, b: 2 })]);',
		expected: {
			ok: true,
			value: [2, 4],
			output: [],
			calls: [
				{ name: 'add', status: 'ok' },
				{ name: 'add', status: 'ok' },
			],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'globals are top-level functions and not recorded as calls',
		code: 'return await sum(1, 2, 3);',
		expected: { ok: true, value: 6, output: [], calls: [], storeWrites: NO_WRITES },
	},
	{
		name: 'store() and load() report writes',
		store: { count: 1, gone: true },
		code: [
			'store("count", load("count") + 1);',
			'store("gone", undefined);',
			'store("list", [1, 2]);',
			'const copy = load("list");',
			'copy.push(3);',
			'return [load("count"), load("gone"), load("list")];',
		].join('\n'),
		expected: {
			ok: true,
			value: [2, null, [1, 2]],
			output: [],
			calls: [],
			storeWrites: { set: { count: 2, list: [1, 2] }, delete: ['gone'] },
		},
	},
	{
		name: 'store() enforces MAX_STORE_VALUE_CHARS',
		code: 'try {\n  store("big", "x".repeat(300000));\n} catch (error) {\n  text(error.name + ": " + error.message);\n}\nreturn load("big");',
		expected: {
			ok: true,
			value: undefined,
			output: [text('RangeError: store("big") value exceeds 262144 characters of JSON')],
			calls: [],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'store() enforces MAX_STORE_TOTAL_CHARS',
		code: [
			'const chunk = "y".repeat(200000);',
			'try {',
			'  for (let i = 0; i < 10; i++) store("k" + i, chunk);',
			'} catch (error) {',
			'  text(error.name + ": " + error.message);',
			'}',
			'return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((i) => load("k" + i) !== undefined).length;',
		].join('\n'),
		expected: {
			ok: true,
			value: 5,
			output: [
				text('RangeError: store is full: stored values would exceed 1048576 characters of JSON'),
			],
			calls: [],
			storeWrites: {
				set: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`k${i}`, 'y'.repeat(200000)])),
				delete: [],
			},
		},
	},
	{
		name: 'a failed script reports no store writes',
		code: 'store("k", 1);\nthrow new Error("after store");',
		expected: {
			ok: false,
			error: { kind: 'script', name: 'Error', message: 'after store' },
			output: [],
			calls: [],
		},
	},
	{
		name: 'exit() ends the script successfully',
		code: 'text("before");\nstore("kept", 1);\nexit();\ntext("after");',
		expected: {
			ok: true,
			value: undefined,
			output: [text('before')],
			calls: [],
			storeWrites: { set: { kept: 1 }, delete: [] },
		},
	},
	{
		name: 'a thrown error fails the script',
		code: 'text("partial");\nthrow new TypeError("bad input");',
		expected: {
			ok: false,
			error: { kind: 'script', name: 'TypeError', message: 'bad input' },
			output: [text('partial')],
			calls: [],
		},
	},
	{
		name: 'a thrown non-error keeps its text',
		code: 'throw "plain";',
		expected: { ok: false, error: { kind: 'script', message: 'plain' }, output: [], calls: [] },
	},
	{
		name: 'a syntax error is a script error',
		code: 'return (;',
		engineMessage: true,
		expected: { ok: false, error: { kind: 'script', name: 'SyntaxError' }, output: [], calls: [] },
	},
	{
		name: 'a promise nothing can settle fails right away',
		code: 'await new Promise(() => {});\nreturn 1;',
		expected: {
			ok: false,
			error: {
				kind: 'script',
				name: 'Error',
				message:
					'The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.',
			},
			output: [],
			calls: [],
		},
	},
	{
		name: 'unawaited calls are cancelled when the script returns',
		code: 'tools.slow({});\nreturn "early";',
		expected: {
			ok: true,
			value: 'early',
			output: [],
			calls: [{ name: 'slow', status: 'cancelled' }],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'image() appends detected images',
		code: `image("data:image/png;base64,${PNG_BASE64}");\nimage({ type: "image", data: "${PNG_BASE64}", mimeType: "image/jpeg" });`,
		expected: {
			ok: true,
			value: undefined,
			output: [
				{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
				{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
			],
			calls: [],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'image() rejects remote URLs',
		code: 'try {\n  image("https://example.com/cat.png");\n} catch (error) {\n  text(error.name + ": " + error.message);\n}',
		expected: {
			ok: true,
			value: undefined,
			output: [
				text(
					'TypeError: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead',
				),
			],
			calls: [],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'scripts have no timers or network',
		code: 'return [typeof setTimeout, typeof setInterval, typeof fetch];',
		expected: {
			ok: true,
			value: ['undefined', 'undefined', 'undefined'],
			output: [],
			calls: [],
			storeWrites: NO_WRITES,
		},
	},
	{
		name: 'the deadline covers time spent in tools',
		code: 'text("waiting");\nawait tools.slow({});\nreturn 1;',
		// Long enough that the sandbox has started and reached the call first.
		timeoutMs: 2_000,
		expected: {
			ok: false,
			error: { kind: 'timeout', message: 'Execution timed out after 2000 ms' },
			output: [text('waiting')],
			calls: [{ name: 'slow', status: 'cancelled' }],
		},
	},
	{
		name: 'the deadline stops a spinning script',
		code: 'while (true) {}',
		timeoutMs: 200,
		skip: {
			dynamicWorker:
				'A spinning Dynamic Worker is stopped by its `limits.cpuMs`, which is not verified under Miniflare; a spin there could hold the test until the pool times out.',
		},
		expected: {
			ok: false,
			error: { kind: 'timeout', message: 'Execution timed out after 200 ms' },
			output: [],
			calls: [],
		},
	},
	{
		name: 'aborting the signal aborts the script',
		code: 'await tools.slow({});\nreturn 1;',
		abortOnCall: 'slow',
		expected: {
			ok: false,
			error: { kind: 'aborted', message: 'stop' },
			output: [],
			calls: [{ name: 'slow', status: 'cancelled' }],
		},
	},
];

/** Drop what is engine timing or engine text; keep everything Pi's contract fixes. */
export function normalizeResult(result: CodemodeResult, engineMessage = false): NormalizedResult {
	const calls = result.calls.map((call) => ({ name: call.name, status: call.status }));
	if (result.ok) {
		return {
			ok: true,
			value: result.value,
			output: result.output,
			calls,
			storeWrites: result.storeWrites,
		};
	}
	const { kind, name, message } = result.error;
	return {
		ok: false,
		error: {
			kind,
			...(name === undefined ? {} : { name }),
			...(engineMessage ? {} : { message }),
		},
		output: result.output,
		calls,
	};
}

/** Run one case against an executor. */
export async function runConformanceCase(
	executor: CodemodeExecutor,
	testCase: ConformanceCase,
): Promise<NormalizedResult> {
	const controller = new AbortController();
	const tools = CONFORMANCE_TOOLS.map((tool) =>
		tool.name === testCase.abortOnCall
			? {
					...tool,
					execute: (args: unknown, context: CodemodeToolContext) => {
						const running = tool.execute(args, context);
						setTimeout(() => controller.abort(new Error('stop')), 0);
						return running;
					},
				}
			: tool,
	);
	try {
		const result = await executor.execute(testCase.code, tools, {
			timeoutMs: testCase.timeoutMs ?? 10_000,
			globals: CONFORMANCE_GLOBALS,
			signal: controller.signal,
			...(testCase.store === undefined ? {} : { store: testCase.store }),
		});
		return normalizeResult(result, testCase.engineMessage);
	} finally {
		controller.abort();
	}
}
