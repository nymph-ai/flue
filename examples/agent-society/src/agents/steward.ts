'use agent';
import { env } from 'cloudflare:workers';
import { useCodeMode, useMcpConnection, useModel, useQuestions } from '@flue/runtime';
import { societyModel } from '../model.ts';

export { cloudflare } from '../qualification/hooks.ts';

const vars = env as unknown as Record<string, unknown>;

/**
 * The steward runs operations on the society's `ops` MCP server (a stateless
 * 2026-07-28 server, `society-ops`, reached through the `OPS` service binding
 * with a bearer token): directly as MCP tools, or from Code Mode scripts,
 * where `ops.record` needs a person's approval. Its questions — approvals and
 * the server's `input_required` — are entity events on its questions stream
 * (docs/cloudflare-native.md rule 9), answered over HTTP or by another agent.
 */
export function Steward() {
	useModel(societyModel());
	const ops = vars.OPS as { fetch: typeof fetch } | undefined;
	if (ops && typeof vars.OPS_MCP_TOKEN === 'string') {
		useMcpConnection({
			name: 'ops',
			url: 'https://society-ops.internal/mcp',
			headers: { authorization: `Bearer ${vars.OPS_MCP_TOKEN}` },
			fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
				ops.fetch(input as never, init)) as typeof fetch,
		});
		useCodeMode({ requiresApproval: ['ops.record'] });
	}
	useQuestions({ timeoutMs: Number(vars.QUESTION_TIMEOUT_MS ?? 1_800_000) });
	return [
		'You are the Steward of a small society of agents. You run operations on the ops MCP server.',
		'Use codemode for scripted operations; a person approves ops.record. Wait for approvals instead of retrying.',
	].join('\n');
}
Steward.agentName = 'steward';
