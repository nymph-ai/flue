'use agent';
import { env } from 'cloudflare:workers';
import { useCodeMode, useMcpConnection, useModel, useQuestions } from '@flue/runtime';
import { libraryModel } from '../model.ts';

export { cloudflare } from '../qualification/hooks.ts';

const vars = env as unknown as Record<string, unknown>;

/**
 * The operator agent runs operations on the `ops` MCP server:
 * directly as MCP tools, or from Code Mode scripts where sensitive actions
 * require authorization. Its approval events are entity events on its
 * questions stream, answered over HTTP or by another agent.
 */
export function Operator() {
	useModel(libraryModel());
	const ops = vars.OPS as { fetch: typeof fetch } | undefined;
	const withOps = ops !== undefined && typeof vars.OPS_MCP_TOKEN === 'string';
	if (ops && withOps) {
		useMcpConnection({
			name: 'ops',
			url: 'https://library-ops.internal/mcp',
			headers: { authorization: `Bearer ${vars.OPS_MCP_TOKEN}` },
			fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
				ops.fetch(input as never, init)) as typeof fetch,
		});
	}
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
		'You are the operations execution agent. You run operations and scripts against the ops MCP server.',
		'Use codemode for scripted operations; tool executions requiring authorization wait for approval events instead of retrying.',
	].join('\n');
}
Operator.agentName = 'operator';

/** Compatibility alias for qualification harness */
export const Steward = Operator;
