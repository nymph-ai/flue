import { describe, expect, it } from 'vitest';
import { AppManager } from '../apps.ts';
import { McpCapabilityProjection } from '../projection.ts';
import { MCP_APP_HTML_MIME } from '../types.ts';

async function setup(): Promise<McpCapabilityProjection> {
	const projection = new McpCapabilityProjection({
		descriptor: { name: 'mcp-apps-stable', version: '0.0.1' },
	});
	projection.registry.register({
		id: 'demo.view',
		kind: 'tool',
		title: 'Demo view',
		inputSchema: { type: 'object', properties: {} },
		ui: { viewUri: 'ui://demo/view', visibility: 'app' },
		invoke: async () => ({
			content: [{ type: 'text', text: 'demo' }],
			structuredContent: { ok: true },
			uiUri: 'ui://demo/view',
		}),
	});
	projection.appManager.registerView(
		{ viewUri: 'ui://demo/view', visibility: 'app', meta: { prefersBorder: true } },
		'<!doctype html><html><body>demo</body></html>',
		{ prefersBorder: true },
	);
	return projection;
}

describe('MCP Apps 2026-01-26 stable wire', () => {
	it('tools/list exposes _meta.ui.resourceUri', async () => {
		const projection = await setup();
		const caps = {
			capabilities: {},
			_meta: {
				'io.modelcontextprotocol/clientCapabilities': {
					extensions: { 'io.modelcontextprotocol/ui': true },
				},
			},
		};
		const res = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: caps,
		})) as any;
		const tool = res.result.tools.find((t: { name: string }) => t.name === 'demo.view');
		expect(tool._meta.ui.resourceUri).toBe('ui://demo/view');
		expect(tool._meta.ui.visibility).toBe('app');
	});

	it('resources/read returns mcp-app mime and _meta.ui', async () => {
		const projection = await setup();
		const caps = {
			_meta: {
				'io.modelcontextprotocol/clientCapabilities': {
					extensions: { 'io.modelcontextprotocol/ui': true },
				},
			},
		};
		const res = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'resources/read',
			params: { uri: 'ui://demo/view', ...caps },
		})) as any;
		const item = res.result.contents[0];
		expect(item.mimeType).toBe(MCP_APP_HTML_MIME);
		expect(item._meta.ui.prefersBorder).toBe(true);
	});

	it('ui/initialize is accepted when UI extension negotiated', async () => {
		const projection = await setup();
		const res = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'ui/initialize',
			params: {
				appCapabilities: { availableDisplayModes: ['inline'] },
				_meta: {
					'io.modelcontextprotocol/clientCapabilities': {
						extensions: { 'io.modelcontextprotocol/ui': true },
					},
				},
			},
		})) as any;
		expect(res.result.hostContext.displayMode).toBe('inline');
	});

	it('AppManager enforces semantic completeness', () => {
		expect(() =>
			AppManager.assertSemanticCompleteness({ uiUri: 'ui://x', content: [] }, 'bad.tool'),
		).toThrow(/semantically complete/);
	});
});
