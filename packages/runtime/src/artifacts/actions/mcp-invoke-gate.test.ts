import { describe, expect, it } from 'vitest';
import { issueViewerToken } from '../auth/tokens.ts';
import { McpCapabilityProjection } from '../../mcp-server/projection.ts';
import { OperationStore } from '../../mcp-server/operations.ts';
import { wireAutoAdmitGovernedOperations } from './operation-port-admission.ts';

const SECRET = 'mcp-gate-secret';
const ARTIFACT = 'artifact://tenant-alpha/scoreboard';
const TENANT = 'tenant-alpha';

function registerScoreTool(projection: McpCapabilityProjection): void {
	projection.registry.register({
		id: 'artifact.score.set',
		kind: 'tool',
		title: 'Set score',
		inputSchema: {
			type: 'object',
			required: ['artifactId', 'tenantId', 'home'],
			properties: {
				artifactId: { type: 'string' },
				tenantId: { type: 'string' },
				home: { type: 'integer' },
			},
		},
		effects: { write: true },
		artifact: {
			requiresFabricAdmission: true,
			allowedTools: ['artifact.score.set'],
		},
		invoke: async () => ({
			resultType: 'complete',
			content: [{ type: 'text', text: 'ok' }],
			structuredContent: { ok: true },
		}),
	});
}

describe('MCP invokeCapability artifact gate', () => {
	it('denies governed artifact tools without Fabric admission verifier path', async () => {
		const port = new OperationStore();
		const projection = new McpCapabilityProjection({
			operationPort: port,
			artifactViewerSecret: SECRET,
		});
		registerScoreTool(projection);
		const token = issueViewerToken(SECRET, {
			artifactId: ARTIFACT,
			tenantId: TENANT,
			principal: 'user:alice',
			tools: ['artifact.score.set'],
			exp: Date.now() + 60_000,
		});
		const res = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'artifact.score.set',
				arguments: { artifactId: ARTIFACT, tenantId: TENANT, home: 1 },
				viewerToken: token,
			},
		})) as { result: { isError?: boolean; structuredContent?: { code?: string } } };
		expect(res.result.isError).toBe(true);
		expect(res.result.structuredContent?.code).toBe('FABRIC_ADMISSION_DENIED');
	});

	it('admits governed artifact tools through OperationPort policy', async () => {
		const port = new OperationStore();
		wireAutoAdmitGovernedOperations(port);
		const projection = new McpCapabilityProjection({
			operationPort: port,
			artifactViewerSecret: SECRET,
		});
		registerScoreTool(projection);
		const token = issueViewerToken(SECRET, {
			artifactId: ARTIFACT,
			tenantId: TENANT,
			principal: 'user:alice',
			tools: ['artifact.score.set'],
			exp: Date.now() + 60_000,
		});
		const res = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'artifact.score.set',
				arguments: { artifactId: ARTIFACT, tenantId: TENANT, home: 2 },
				viewerToken: token,
			},
		})) as { result: { isError?: boolean; structuredContent?: { ok?: boolean } } };
		expect(res.result.isError).not.toBe(true);
		expect(res.result.structuredContent?.ok).toBe(true);
	});

	it('does not gate non-artifact tools', async () => {
		const port = new OperationStore();
		const projection = new McpCapabilityProjection({ operationPort: port });
		projection.registry.register({
			id: 'demo.echo',
			kind: 'tool',
			title: 'Echo',
			inputSchema: { type: 'object', properties: {} },
			invoke: async () => ({
				resultType: 'complete',
				content: [{ type: 'text', text: 'echo' }],
			}),
		});
		const res = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'demo.echo', arguments: {} },
		})) as { result: { content?: Array<{ text: string }> } };
		expect(res.result.content?.[0]?.text).toBe('echo');
	});
});
