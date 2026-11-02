// Fabric to the operator's Dot and back over this connector (nymphai
// fabric/DOTS.md D10-D14, phase 1).
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app.ts';
import { createMcpRouter } from '../src/mcp/router.ts';
import { CALLS_PER_CAPABILITY_HOUR, TaskStore } from '../src/mcp/tasks.ts';
import { LibraryVault } from '../src/wiki/storage.ts';

function sqlStore(fabric?: (tool: string, args: Record<string, unknown>) => Promise<unknown>) {
	const db = new DatabaseSync(':memory:');
	const sql = {
		exec: (query: string, ...bindings: unknown[]) => {
			const stmt = db.prepare(query);
			const clean = bindings.map((b) => (b === undefined ? null : b));
			if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) {
				const rows = stmt.all(...(clean as never[])) as Record<string, unknown>[];
				return { toArray: () => rows };
			}
			stmt.run(...(clean as never[]));
			return { toArray: () => [] };
		},
	};
	const store = new TaskStore(() => new LibraryVault(), { sql, fabric: fabric as never });
	return { db, store };
}

const DOT_CALLBACK = 'https://connectors.example/webhook/dot';
const OTHER_CALLBACK = 'https://connectors.example/webhook/other';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

/** Webhooks the store sends, by callback; each answers `status`. */
function captureWebhooks(status = 200) {
	const seen: Array<{ url: string; body: any }> = [];
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		seen.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
		return new Response('', { status });
	});
	return seen;
}

async function subscribe(store: TaskStore, url: string, correlationId: string) {
	const { subscription } = await store.subscribe({
		callbackUrl: url,
		secret: SECRET,
		filter: { correlationId },
	});
	return subscription.id;
}

const MESSAGE = {
	message_id: 'msg-1',
	from: '/nymphai/claude-1',
	text: 'Please make the package public.',
	expects_reply: true,
	sent_at: '2026-11-02T00:00:00Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('Fabric messages to the Dot', () => {
	it('become a fabric_message task whose event reaches only the Dot, once', async () => {
		const seen = captureWebhooks();
		const { store } = sqlStore();
		const dot = await subscribe(store, DOT_CALLBACK, 'dot-thread');
		await subscribe(store, OTHER_CALLBACK, 'dot-thread');
		seen.length = 0;

		const outcome = await store.deliverFabricMessage(MESSAGE, dot);
		expect(outcome.delivered).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe(DOT_CALLBACK);
		const data = seen[0]!.body.data;
		expect(data.taskId).toBe(outcome.taskId);
		expect(data.correlationId).toBe('dot-thread');
		expect(data.status).toBe('input_required');
		expect(data.kind).toBe('fabric_message');
		expect(data.fabricMessage.messageId).toBe('msg-1');
		expect(data.fabricMessage.from).toBe('/nymphai/claude-1');
		expect(data.fabricMessage.replyCapability).toMatch(/^cap_[0-9a-f]{32}$/);

		// dots-host sending it again is the same task and no second event.
		const again = await store.deliverFabricMessage(MESSAGE, dot);
		expect(again).toEqual({ delivered: true, taskId: outcome.taskId });
		expect(seen).toHaveLength(1);

		// A later subscriber replaying history does not see the Dot's message.
		seen.length = 0;
		await subscribe(store, 'https://connectors.example/webhook/late', 'dot-thread');
		expect(seen.every((s) => s.body.data.taskId !== outcome.taskId)).toBe(true);
	});

	it('wait when the Dot has no subscription or its webhook refuses', async () => {
		captureWebhooks(500);
		const { store } = sqlStore();
		expect(await store.deliverFabricMessage(MESSAGE, 'sub_missing')).toEqual({
			delivered: false,
			reason: 'no_subscription',
		});
		const dot = await subscribe(store, DOT_CALLBACK, 'dot-thread');
		const refused = await store.deliverFabricMessage(MESSAGE, dot);
		expect(refused).toMatchObject({ delivered: false, reason: 'webhook_refused', statusCode: 500 });
		captureWebhooks(200);
		expect((await store.deliverFabricMessage(MESSAGE, dot)).delivered).toBe(true);
	});
});

describe("The Dot's Fabric tools", () => {
	it('need a capability Fabric gave the Dot, and are rate limited', async () => {
		const seen = captureWebhooks();
		const calls: Array<[string, Record<string, unknown>]> = [];
		const { store } = sqlStore(async (tool, args) => {
			calls.push([tool, args]);
			return { proc: '/nymphai/dot-chatgpt', result: { content: [{ type: 'text', text: 'ok' }] } };
		});
		const dot = await subscribe(store, DOT_CALLBACK, 'dot-thread');
		await store.deliverFabricMessage(MESSAGE, dot);
		const capability = seen.at(-1)!.body.data.fabricMessage.replyCapability as string;

		expect(await store.fabricTool('query', { target: 'procs' })).toHaveProperty('refused');
		expect(await store.fabricTool('query', { target: 'procs', capability: 'cap_' + '0'.repeat(32) })).toHaveProperty(
			'refused',
		);
		expect(calls).toHaveLength(0);

		const ok = await store.fabricTool('send', { to: '/nymphai/a', text: 'hi', capability });
		expect(ok).toHaveProperty('result');
		expect(calls[0]).toEqual(['send', { to: '/nymphai/a', text: 'hi' }]);

		for (let i = 1; i < CALLS_PER_CAPABILITY_HOUR; i++) {
			expect(await store.fabricTool('query', { target: 'procs', capability })).toHaveProperty('result');
		}
		expect((await store.fabricTool('query', { target: 'procs', capability })).refused).toMatch(/budget/);
	});

	it('answer a Fabric message through acknowledge_result, in its thread', async () => {
		const seen = captureWebhooks();
		const calls: Array<[string, Record<string, unknown>]> = [];
		const { store } = sqlStore(async (tool, args) => {
			calls.push([tool, args]);
			return { proc: '/nymphai/dot-chatgpt', result: { content: [] } };
		});
		const dot = await subscribe(store, DOT_CALLBACK, 'dot-thread');
		const { taskId } = await store.deliverFabricMessage(MESSAGE, dot);
		const capability = seen.at(-1)!.body.data.fabricMessage.replyCapability as string;

		expect((await store.fabricReply(taskId!, { reply: 'done' })).refused).toMatch(/capability/);
		const answered = await store.fabricReply(taskId!, { reply: 'Done: it is public.', capability });
		expect(answered.result).toMatchObject({ replied: true });
		expect(calls).toEqual([
			['send', { to: '/nymphai/claude-1', text: 'Done: it is public.', reply_to: 'msg-1' }],
		]);
		expect(store.getTask(taskId!)?.status).toBe('completed');
		expect(seen.at(-1)!.body.data).toMatchObject({ taskId, status: 'completed' });
		// Not a Fabric message: the ordinary acknowledgement path.
		expect((await store.fabricReply('task_other', {})).result).toBeNull();
	});

	it('are listed on the connector and refuse without a capability', async () => {
		const mcp = createMcpRouter();
		const list = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		});
		const tools = ((await list.json()) as any).result.tools as Array<{ name: string; inputSchema: any }>;
		for (const name of ['send', 'delegate', 'query']) {
			const tool = tools.find((t) => t.name === name);
			expect(tool?.inputSchema.required).toContain('capability');
		}
		const call = await mcp.request('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: { name: 'query', arguments: { target: 'procs' } },
			}),
		});
		const result = ((await call.json()) as any).result;
		expect(result.isError).toBe(true);
	});
});

describe('POST /fabric/messages', () => {
	it("takes only dots-host's secret", async () => {
		const env = { FABRIC_DOTS_TOKEN: 't'.repeat(64), DOT_SUBSCRIPTION_ID: 'sub_missing' };
		const anonymous = await app.request('/fabric/messages', { method: 'POST', body: '{}' }, env);
		expect(anonymous.status).toBe(401);
		const unset = await app.request(
			'/fabric/messages',
			{ method: 'POST', headers: { authorization: 'Bearer ' }, body: '{}' },
			{},
		);
		expect(unset.status).toBe(401);
		const noSub = await app.request(
			'/fabric/messages',
			{ method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(64)}` }, body: JSON.stringify(MESSAGE) },
			env,
		);
		expect(noSub.status).toBe(503);
		expect(await noSub.json()).toMatchObject({ delivered: false, reason: 'no_subscription' });
	});
});
