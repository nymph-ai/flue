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
 * where `tools.mcp__ops__record` needs a person's approval. Its questions — approvals and
 * the server's `input_required` — are entity events on its questions stream
 * (docs/cloudflare-native.md rule 9), answered over HTTP or by another agent.
 * It also reads the real Linear (a 2025-revision server, spoken through
 * `initialize`) for the Code Mode demo, limited to three read-only tools.
 */
export function Steward() {
	useModel(societyModel());
	const ops = vars.OPS as { fetch: typeof fetch } | undefined;
	const withOps = ops !== undefined && typeof vars.OPS_MCP_TOKEN === 'string';
	if (ops && withOps) {
		useMcpConnection({
			name: 'ops',
			url: 'https://society-ops.internal/mcp',
			headers: { authorization: `Bearer ${vars.OPS_MCP_TOKEN}` },
			fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
				ops.fetch(input as never, init)) as typeof fetch,
		});
	}
	// The real Linear MCP server, read-only: the Code Mode demo's
	// `codemode teams` / `codemode frustration <team>` (LINEAR_API_KEY).
	if (typeof vars.LINEAR_API_KEY === 'string') {
		useMcpConnection({
			name: 'linear',
			url: 'https://mcp.linear.app/mcp',
			headers: { authorization: `Bearer ${vars.LINEAR_API_KEY}` },
			tools: ['list_teams', 'list_issues', 'list_comments'],
		});
	}
	if (withOps || typeof vars.LINEAR_API_KEY === 'string') {
		useCodeMode({ requiresApproval: ['mcp__ops__record'] });
	}
	useQuestions({ timeoutMs: Number(vars.QUESTION_TIMEOUT_MS ?? 1_800_000) });
	return [
		'You are the Steward of a small society of agents. You run operations on the ops MCP server.',
		'Use codemode for scripted operations; a person approves tools.mcp__ops__record. Wait for approvals instead of retrying.',
	].join('\n');
}
Steward.agentName = 'steward';
