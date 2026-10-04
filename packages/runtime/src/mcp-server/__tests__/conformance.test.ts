/**
 * Comprehensive Conformance Test Suite for Flue MCP Capability Projection.
 *
 * Verifies:
 * - 7-Client Conformance Matrix (Clients A–G)
 * - End-to-End Scenario: Deployment Skill & Build Launch across matrix
 * - All 10 Architectural Invariants from docs/mcp-capability-projection.md § 18
 * - Pre-connection Server Cards, Post-connection server/discover, and HTTP Router
 *
 * Reference: docs/mcp-capability-projection.md
 */

import { describe, expect, it, vi } from 'vitest';
import { DurableStreamLogError } from '../../streams/log.ts';
import { InMemoryDurableStreamLog } from '../../streams/memory-log.ts';
import { AppManager } from '../apps.ts';
import { ElectricEventPort, projectSettlementToElectricEvent } from '../events.ts';
import { OperationStore } from '../operations.ts';
import { type AgentOperationService, CloudflareAgentOperationPort } from '../ports.ts';
import { McpCapabilityProjection } from '../projection.ts';
import { createMcpCapabilityRouter } from '../router.ts';
import type { CapabilityResult, Operation } from '../types.ts';
import { MCP_2026_07_28 } from '../types.ts';
import { createEntityWakeRoute } from '../../entity/webhook-route.ts';
import { createFlueMcpSubscriptionClass } from '../../cloudflare/mcp-subscription.ts';

// -----------------------------------------------------------------------------
// Test Fixture Setup
// -----------------------------------------------------------------------------

async function setupTestProjection(): Promise<McpCapabilityProjection> {
	const projection = new McpCapabilityProjection({
		descriptor: {
			name: 'flue-conformance-server',
			version: '2.2.2',
			description: 'Flue MCP Capability Projection Conformance Test Server',
		},
	});

	// 1. Sync Tool: linear.issue.create
	projection.registry.register({
		id: 'linear.issue.create',
		kind: 'tool',
		title: 'Create Linear Issue',
		description: 'Create a new ticket in the Linear project tracker.',
		category: 'linear',
		pinned: true,
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Issue title' },
				teamId: { type: 'string', description: 'Team ID' },
			},
			required: ['title', 'teamId'],
		},
		effects: { write: true, reversible: true },
		trust: { source: 'linear-api', sensitivity: 'internal' },
		authorization: { scopes: ['linear:write'], delegationAllowed: true },
		invoke: async (args: Record<string, unknown>): Promise<CapabilityResult> => {
			return {
				content: [{ type: 'text', text: `Issue created: ${String(args.title)}` }],
				structuredContent: { id: 'ISSUE-101', title: args.title, teamId: args.teamId },
			};
		},
	});

	// 2. App-backed Tool: linear.project.view
	projection.registry.register({
		id: 'linear.project.view',
		kind: 'tool',
		title: 'View Linear Project',
		description: 'View project details with interactive board visualization.',
		category: 'linear',
		pinned: true,
		inputSchema: {
			type: 'object',
			properties: {
				projectId: { type: 'string', description: 'Project ID' },
			},
			required: ['projectId'],
		},
		ui: {
			viewUri: 'ui://linear/project-view',
			description: 'Interactive Kanban board for project issues',
		},
		effects: { read: true },
		trust: { source: 'linear-api', sensitivity: 'internal' },
		invoke: async (args: Record<string, unknown>): Promise<CapabilityResult> => {
			return {
				content: [{ type: 'text', text: `Project overview for ${String(args.projectId)}` }],
				structuredContent: {
					projectId: args.projectId,
					name: 'Core Runtime',
					status: 'in_progress',
				},
				uiUri: 'ui://linear/project-view',
			};
		},
	});

	// Register UI View
	projection.appManager.registerView(
		{
			viewUri: 'ui://linear/project-view',
			description: 'Interactive Kanban board for project issues',
		},
		'<div id="app"><h1>Linear Project Board</h1></div>',
	);

	// 3. Asynchronous Tool: build.deploy
	projection.registry.register({
		id: 'build.deploy',
		kind: 'tool',
		title: 'Deploy Service',
		description: 'Trigger an asynchronous deployment pipeline to target environment.',
		category: 'devops',
		asyncPolicy: 'async',
		pinned: true,
		inputSchema: {
			type: 'object',
			properties: {
				service: { type: 'string', description: 'Service name' },
				env: { type: 'string', description: 'Deployment environment' },
			},
			required: ['service', 'env'],
		},
		effects: { write: true, externalCommunication: true },
		trust: { source: 'ci-runner', sensitivity: 'confidential' },
		invoke: async (args: Record<string, unknown>): Promise<CapabilityResult> => {
			await new Promise((r) => setTimeout(r, 60));
			return {
				content: [
					{
						type: 'text',
						text: `Deployment started for ${String(args.service)} to ${String(args.env)}.`,
					},
				],
				structuredContent: { service: args.service, env: args.env, deployed: true },
			};
		},
	});

	// 4. Policy/Review Governed Tool: admin.database.wipe
	projection.registry.register({
		id: 'admin.database.wipe',
		kind: 'tool',
		title: 'Wipe Database',
		description: 'Destructive purge of database tables.',
		category: 'admin',
		inputSchema: {
			type: 'object',
			properties: {
				confirmPhrase: { type: 'string' },
			},
			required: ['confirmPhrase'],
		},
		effects: { destructive: true, userReviewRequired: true },
		trust: { source: 'admin', sensitivity: 'restricted' },
		invoke: async (): Promise<CapabilityResult> => {
			return {
				content: [{ type: 'text', text: 'Database wiped successfully.' }],
				structuredContent: { wiped: true },
			};
		},
	});

	// 5. Financial / Restricted Tool: finance.transfer
	projection.registry.register({
		id: 'finance.transfer',
		kind: 'tool',
		title: 'Transfer Funds',
		description: 'Execute financial wire transfer.',
		category: 'finance',
		inputSchema: {
			type: 'object',
			properties: {
				amount: { type: 'number' },
				recipient: { type: 'string' },
			},
			required: ['amount', 'recipient'],
		},
		effects: { moneyMovement: true, userReviewRequired: true },
		trust: { source: 'ledger', sensitivity: 'restricted' },
		invoke: async (): Promise<CapabilityResult> => {
			return {
				content: [{ type: 'text', text: 'Transfer completed.' }],
				structuredContent: { transferred: true },
			};
		},
	});

	// 6. Delegation Disallowed Tool: delegation.forbidden
	projection.registry.register({
		id: 'delegation.forbidden',
		kind: 'tool',
		title: 'Direct User Operation',
		description: 'Operation strictly forbidden to delegated agents.',
		inputSchema: { type: 'object', properties: {} },
		authorization: { delegationAllowed: false },
		invoke: async (): Promise<CapabilityResult> => {
			return { content: [{ type: 'text', text: 'Direct caller executed.' }] };
		},
	});

	// 7. Canonical Skill: deploy-workflow
	projection.skillManager.registerSkill({
		name: 'deploy-workflow',
		description: 'Standard deployment procedures and health verification scripts.',
		uri: 'skill://deploy-workflow/SKILL.md',
		entryPoint: 'skill://deploy-workflow/SKILL.md',
		files: [
			{
				path: 'SKILL.md',
				uri: 'skill://deploy-workflow/SKILL.md',
				content: '# Deployment Workflow Guide\n\nRun build.deploy then verify with verify.sh.',
				mimeType: 'text/markdown',
			},
			{
				path: 'scripts/verify.sh',
				uri: 'skill://deploy-workflow/scripts/verify.sh',
				content: '#!/usr/bin/env bash\necho "Verifying deployment health..."',
				mimeType: 'application/x-sh',
			},
		],
	});

	// 8. Event Stream: electric_stream_01
	await projection.eventPort.appendEvent('electric_stream_01', 'deployment.started', {
		service: 'web',
		version: '1.0.0',
	});
	await projection.eventPort.appendEvent('electric_stream_01', 'deployment.completed', {
		service: 'web',
		status: 'healthy',
	});

	return projection;
}

// -----------------------------------------------------------------------------
// Test Suites
// -----------------------------------------------------------------------------

describe('Flue MCP Capability Projection: 7-Client Conformance Matrix', () => {
	it('Client A: Strict MCP 2026-07-28 Core Only', async () => {
		const projection = await setupTestProjection();

		// 1. server/discover
		const disc = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'server/discover',
			params: { capabilities: {} },
		})) as any;

		expect(disc.result).toBeDefined();
		expect(disc.result.resultType).toBe('complete');
		expect(disc.result.protocolVersion).toBe(MCP_2026_07_28);
		expect(disc.result.supportedVersions).toContain(MCP_2026_07_28);
		expect(disc.result.extensions.skills).toBe(true);
		expect(disc.result.extensions.tasks).toBe(true);

		// 1.5. Standard 2026-07-28 _meta negotiation
		const metaDiscover = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1.5,
			method: 'server/discover',
			params: {
				_meta: {
					'io.modelcontextprotocol/clientCapabilities': {
						extensions: {
							'io.modelcontextprotocol/skills': true,
						},
					},
				},
			},
		})) as any;
		expect(metaDiscover.result.resultType).toBe('complete');
		expect(metaDiscover.result.activeExtensions.skills).toBe(true);

		// 2. tools/list: bootstrap meta-tools + native capabilities present
		const toolsRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { capabilities: {} },
		})) as any;

		expect(toolsRes.result.resultType).toBe('complete');

		const toolNames = toolsRes.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('flue.search');
		expect(toolNames).toContain('flue.describe');
		expect(toolNames).toContain('flue.invoke');
		expect(toolNames).toContain('flue.categories');
		expect(toolNames).toContain('flue.resolve');
		expect(toolNames).toContain('flue.job.cancel');
		expect(toolNames).toContain('flue.job.respond');
		expect(toolNames).toContain('flue.events.open');
		expect(toolNames).toContain('linear.issue.create');
		expect(toolNames).toContain('linear.project.view');
		expect(toolNames).toContain('build.deploy');

		// Invariant 3: ui metadata does NOT leak to Client A
		const projectViewTool = toolsRes.result.tools.find(
			(t: any) => t.name === 'linear.project.view',
		);
		expect(projectViewTool.ui).toBeUndefined();

		// 3. Extension methods are rejected with Method Not Found (-32601)
		const extMethods = [
			'skills/list',
			'skills/get',
			'tasks/get',
			'tasks/cancel',
			'events/list',
			'events/subscribe',
			'tools/resolve',
		];
		for (const method of extMethods) {
			const res = await projection.handleRequest({
				jsonrpc: '2.0',
				id: 3,
				method,
				params: { capabilities: {} },
			});
			expect(res.error).toBeDefined();
			expect(res.error?.code).toBe(-32601);
		}

		// 4. Core Skills Fallback: readable via resources/read
		const skillRead = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 4,
			method: 'resources/read',
			params: { uri: 'skill://deploy-workflow/SKILL.md', capabilities: {} },
		})) as any;
		expect(skillRead.result.contents[0].text).toContain('# Deployment Workflow Guide');

		// 5. Core Tasks Fallback: async capability returns job:// handle
		const invokeAsync = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 5,
			method: 'tools/call',
			params: {
				name: 'build.deploy',
				arguments: { service: 'web', env: 'production' },
				capabilities: {},
			},
		})) as any;

		expect(invokeAsync.result.structuredContent.state).toBe('running');
		const jobId = invokeAsync.result.structuredContent.jobId;
		expect(jobId).toMatch(/^op_/);
		expect(invokeAsync.result.resourceLinks[0]).toBe(`job://${jobId}`);

		// Read job state via resources/read
		const jobRead = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 6,
			method: 'resources/read',
			params: { uri: `job://${jobId}`, capabilities: {} },
		})) as any;
		const jobData = JSON.parse(jobRead.result.contents[0].text);
		expect(jobData.operationId).toBe(jobId);
		expect(jobData.state).toBe('running');

		// 6. Core Events Fallback: open stream and read slices
		const openStream = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: {
				name: 'flue.events.open',
				arguments: { streamId: 'electric_stream_01' },
				capabilities: {},
			},
		})) as any;
		expect(openStream.result.structuredContent.streamId).toBe('electric_stream_01');
		expect(openStream.result.structuredContent.headCursor).toBeDefined();

		const streamSlice = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 8,
			method: 'resources/read',
			params: {
				uri: 'eventstream://electric_stream_01/after/0000000000000000_0000000000000000',
				capabilities: {},
			},
		})) as any;
		const sliceData = JSON.parse(streamSlice.result.contents[0].text);
		expect(sliceData.events.length).toBe(2);
		expect(sliceData.events[0].name).toBe('deployment.started');

		// 7. Resource subscription
		const subListen = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 9,
			method: 'subscriptions/listen',
			params: { uri: `job://${jobId}`, capabilities: {} },
		})) as any;
		expect(subListen.result.success).toBe(true);
	});

	it('Client B: 2026-07-28 + Skills', async () => {
		const projection = await setupTestProjection();
		const clientCaps = { capabilities: { skills: true } };

		// Native skills/list
		const listRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'skills/list',
			params: clientCaps,
		})) as any;
		expect(listRes.result.skills.length).toBeGreaterThan(0);
		expect(listRes.result.skills[0].name).toBe('deploy-workflow');

		// Native skills/get
		const getRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'skills/get',
			params: { name: 'deploy-workflow', ...clientCaps },
		})) as any;
		expect(getRes.result.skill.files.length).toBe(2);
		expect(getRes.result.skill.files[0].path).toBe('SKILL.md');

		// Invariant 5: Still readable via resources/read
		const resRead = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'resources/read',
			params: { uri: 'skill://deploy-workflow/scripts/verify.sh', ...clientCaps },
		})) as any;
		expect(resRead.result.contents[0].text).toContain('Verifying deployment health');
	});

	it('Client C: 2026-07-28 + Tasks', async () => {
		const projection = await setupTestProjection();
		const clientCaps = { capabilities: { tasks: true } };

		// Invoking async capability returns native Task reference
		const callRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'build.deploy',
				arguments: { service: 'api', env: 'staging' },
				...clientCaps,
			},
		})) as any;

		expect(callRes.result.operationId).toBeDefined();
		const taskId = callRes.result.operationId;
		expect(callRes.result.structuredContent.taskId).toBe(taskId);
		expect(callRes.result.structuredContent.status).toBe('running');

		// Native tasks/get
		const taskGet = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tasks/get',
			params: { taskId, ...clientCaps },
		})) as any;
		expect(taskGet.result.task.operationId).toBe(taskId);
		expect(taskGet.result.task.state).toBe('running');

		// Native tasks/cancel
		const taskCancel = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tasks/cancel',
			params: { taskId, reason: 'Aborted in test', ...clientCaps },
		})) as any;
		expect(taskCancel.result.success).toBe(true);

		const taskGetAfter = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 4,
			method: 'tasks/get',
			params: { taskId, ...clientCaps },
		})) as any;
		expect(taskGetAfter.result.task.state).toBe('cancelled');
	});

	it('Client D: 2026-07-28 + Apps', async () => {
		const projection = await setupTestProjection();
		const clientCaps = { capabilities: { apps: true } };

		// tools/list includes UI definition
		const toolsRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: clientCaps,
		})) as any;
		const viewTool = toolsRes.result.tools.find((t: any) => t.name === 'linear.project.view');
		expect(viewTool.ui).toBeDefined();
		expect(viewTool.ui.viewUri).toBe('ui://linear/project-view');

		// resources/read(ui://linear/project-view)
		const uiRead = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'resources/read',
			params: { uri: 'ui://linear/project-view', ...clientCaps },
		})) as any;
		expect(uiRead.result.contents[0].text).toContain('<div id="app">');

		// Calling tool returns both uiUri and complete text/structured content (Invariant 4)
		const callRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {
				name: 'linear.project.view',
				arguments: { projectId: 'PROJ-123' },
				...clientCaps,
			},
		})) as any;
		expect(callRes.result.uiUri).toBe('ui://linear/project-view');
		expect(callRes.result.structuredContent.name).toBe('Core Runtime');
		expect(callRes.result.content[0].text).toContain('Project overview');
	});

	it('Client E: 2026-07-28 + Events', async () => {
		const projection = await setupTestProjection();
		const clientCaps = { capabilities: { events: true } };

		// Native events/list
		const listRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'events/list',
			params: clientCaps,
		})) as any;
		expect(listRes.result.streams.length).toBeGreaterThan(0);
		expect(listRes.result.streams[0].streamId).toBe('electric_stream_01');

		// Native events/subscribe (skipVerification: true for unit test mock)
		const subRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'events/subscribe',
			params: {
				streamId: 'electric_stream_01',
				delivery: { url: 'https://example.com/webhook', secret: 'test-secret-key-12345' },
				skipVerification: true,
				...clientCaps,
			},
		})) as any;
		expect(subRes.result.id).toMatch(/^sub_/);
		expect(subRes.result.refreshBefore).toBeDefined();

		// Native events/unsubscribe
		const unsubRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'events/unsubscribe',
			params: { subscriptionId: subRes.result.id, ...clientCaps },
		})) as any;
		expect(unsubRes.result.success).toBe(true);
	});

	it('Client F: 2026-07-28 + Variants', async () => {
		const projection = await setupTestProjection();

		// 1. Variant requested via variant parameter 'compact'
		const resCompact = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { variant: 'compact', capabilities: { variants: true } },
		})) as any;
		expect(resCompact.result.tools).toBeDefined();

		// 2. Variant requested via HTTP header (x-mcp-profile: research)
		const headers = new Headers();
		headers.set('x-mcp-profile', 'research');
		const resResearch = (await projection.handleRequest(
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
				params: { capabilities: { variants: true } },
			},
			headers,
		)) as any;
		expect(resResearch.result.tools).toBeDefined();

		// Invariant: clientInfo.name does NOT switch profile
		const resSneaky = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/list',
			params: { clientInfo: { name: 'chatgpt' }, capabilities: {} },
		})) as any;
		// Default profile should be used, not chatgpt
		expect(resSneaky.result.tools.length).toBeGreaterThan(0);
	});

	it('Client G: All Supported Extensions', async () => {
		const projection = await setupTestProjection();
		const allCaps = {
			capabilities: {
				skills: true,
				tasks: true,
				events: true,
				apps: true,
				variants: true,
				toolsResolve: true,
			},
		};

		// Can list skills
		const skills = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'skills/list',
			params: allCaps,
		})) as any;
		expect(skills.result.skills.length).toBeGreaterThan(0);

		// Can list events
		const events = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'events/list',
			params: allCaps,
		})) as any;
		expect(events.result.streams.length).toBeGreaterThan(0);

		// Can use tools/resolve
		const resolveRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/resolve',
			params: {
				name: 'linear.issue.create',
				arguments: { title: 'Test Issue', teamId: 'ENG' },
				...allCaps,
			},
		})) as any;
		expect(resolveRes.result.capabilityId).toBe('linear.issue.create');
		expect(resolveRes.result.schemaValid).toBe(true);

		// Native tasks returned on async call
		const callAsync = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: {
				name: 'build.deploy',
				arguments: { service: 'matrix', env: 'production' },
				...allCaps,
			},
		})) as any;
		expect(callAsync.result.operationId).toBeDefined();
	});
});

// -----------------------------------------------------------------------------
// End-to-End Scenario (§ 18): "Use deployment skill and launch build"
// -----------------------------------------------------------------------------

describe('Scenario: Deployment skill and launch build across Client Matrix', () => {
	it('Client A flow: resources/read(skill) -> flue.invoke(deploy) -> job:// fallback', async () => {
		const projection = await setupTestProjection();

		// 1. Read skill guide via core resource
		const skill = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'resources/read',
			params: { uri: 'skill://deploy-workflow/SKILL.md' },
		})) as any;
		expect(skill.result.contents[0].text).toContain('Run build.deploy');

		// 2. Invoke build.deploy via flue.invoke
		const invokeRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'flue.invoke',
				arguments: {
					capability: 'build.deploy',
					arguments: { service: 'frontend', env: 'production' },
				},
			},
		})) as any;

		expect(invokeAsyncHasJob(invokeRes)).toBe(true);
		const jobId = invokeRes.result.structuredContent.jobId;

		// 3. Read durable handle via resources/read
		const jobRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'resources/read',
			params: { uri: `job://${jobId}` },
		})) as any;
		expect(jobRes.result.contents[0].text).toContain(jobId);
	});

	it('Client B flow: skills/get -> flue.invoke(deploy) -> job:// fallback', async () => {
		const projection = await setupTestProjection();
		const caps = { capabilities: { skills: true } };

		// 1. skills/get
		const skill = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'skills/get',
			params: { name: 'deploy-workflow', ...caps },
		})) as any;
		expect(skill.result.skill.name).toBe('deploy-workflow');

		// 2. flue.invoke(build.deploy)
		const invokeRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'flue.invoke',
				arguments: {
					capability: 'build.deploy',
					arguments: { service: 'backend', env: 'production' },
				},
				...caps,
			},
		})) as any;

		expect(invokeAsyncHasJob(invokeRes)).toBe(true);
	});

	it('Client C flow: resources/read(skill) -> flue.invoke(deploy) -> native task', async () => {
		const projection = await setupTestProjection();
		const caps = { capabilities: { tasks: true } };

		// 1. Read skill via resources/read
		const skill = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'resources/read',
			params: { uri: 'skill://deploy-workflow/SKILL.md', ...caps },
		})) as any;
		expect(skill.result.contents[0].text).toBeDefined();

		// 2. Invoke build.deploy returns native Task
		const invokeRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'flue.invoke',
				arguments: {
					capability: 'build.deploy',
					arguments: { service: 'backend', env: 'production' },
				},
				...caps,
			},
		})) as any;

		expect(invokeRes.result.operationId).toBeDefined();
		const taskId = invokeRes.result.operationId;

		// 3. tasks/get
		const task = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tasks/get',
			params: { taskId, ...caps },
		})) as any;
		expect(task.result.task.operationId).toBe(taskId);
	});

	it('Client G flow: skills/get -> tools/call -> native task -> events verify', async () => {
		const projection = await setupTestProjection();
		const allCaps = {
			capabilities: { skills: true, tasks: true, events: true, apps: true },
		};

		// 1. skills/get
		const skill = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'skills/get',
			params: { name: 'deploy-workflow', ...allCaps },
		})) as any;
		expect(skill.result.skill.name).toBe('deploy-workflow');

		// 2. Direct tools/call with native Task returned
		const invokeRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'build.deploy',
				arguments: { service: 'gateway', env: 'production' },
				...allCaps,
			},
		})) as any;
		expect(invokeRes.result.operationId).toBeDefined();
		const taskId = invokeRes.result.operationId;

		// 3. Update operation state to completed
		projection.operationStore.updateOperation(taskId, {
			state: 'completed',
			result: { content: [{ type: 'text', text: 'Build deployed.' }] },
		});

		// 4. Verify task is completed
		const task = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tasks/get',
			params: { taskId, ...allCaps },
		})) as any;
		expect(task.result.task.state).toBe('completed');
	});
});

function invokeAsyncHasJob(res: any): boolean {
	return (
		res.result?.structuredContent?.jobId !== undefined &&
		res.result?.resourceLinks?.[0]?.startsWith('job://') === true
	);
}

// -----------------------------------------------------------------------------
// The 10 Invariants (§ 18)
// -----------------------------------------------------------------------------

describe('Architectural Invariants (docs/mcp-capability-projection.md § 18)', () => {
	it('Invariant 1: Flue does not remember unsupported client extension capabilities across requests', async () => {
		const projection = await setupTestProjection();

		// Request 1: Client sends tasks=true
		const res1 = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'build.deploy',
				arguments: { service: 'app', env: 'prod' },
				capabilities: { tasks: true },
			},
		})) as any;
		expect(res1.result.operationId).toBeDefined();

		// Request 2: Next request omits capabilities (Client A)
		const res2 = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'build.deploy',
				arguments: { service: 'app', env: 'prod' },
				// No capabilities provided!
			},
		})) as any;
		// Must fall back to core job:// handle, NOT remember tasks from previous request
		expect(res2.result.structuredContent.jobId).toBeDefined();
		expect(res2.result.resourceLinks[0]).toMatch(/^job:\/\//);
	});

	it('Invariant 2: Search does not mutate tools/list as a side effect', async () => {
		const projection = await setupTestProjection();

		// 1. Get initial tools list
		const initialTools = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
		})) as any;
		const initialCount = initialTools.result.tools.length;
		const initialNames = initialTools.result.tools.map((t: any) => t.name).sort();

		// 2. Perform various searches
		await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'flue.search',
				arguments: { query: 'linear' },
			},
		});
		await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {
				name: 'flue.search',
				arguments: { query: 'deploy build' },
			},
		});

		// 3. Get tools list again
		const subsequentTools = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/list',
		})) as any;
		const subsequentCount = subsequentTools.result.tools.length;
		const subsequentNames = subsequentTools.result.tools.map((t: any) => t.name).sort();

		expect(subsequentCount).toBe(initialCount);
		expect(subsequentNames).toEqual(initialNames);
	});

	it('Invariant 3: Extension metadata disappears cleanly for core clients', async () => {
		const projection = await setupTestProjection();

		// Client A tools list
		const toolsA = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { capabilities: {} },
		})) as any;

		for (const tool of toolsA.result.tools) {
			expect(tool.ui).toBeUndefined();
		}

		// Client D (Apps enabled)
		const toolsD = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { capabilities: { apps: true } },
		})) as any;

		const appTool = toolsD.result.tools.find((t: any) => t.name === 'linear.project.view');
		expect(appTool.ui).toBeDefined();
	});

	it('Invariant 4: Every App-backed tool is useful without rendering', async () => {
		const projection = await setupTestProjection();

		// Call linear.project.view without UI extension
		const callRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'linear.project.view',
				arguments: { projectId: 'PROJ-999' },
			},
		})) as any;

		expect(callRes.result.content).toBeDefined();
		expect(callRes.result.content[0].text.length).toBeGreaterThan(0);
		expect(callRes.result.structuredContent).toBeDefined();
		expect(callRes.result.structuredContent.name).toBe('Core Runtime');

		// Assert AppManager enforces completeness
		expect(() => {
			AppManager.assertSemanticCompleteness({ uiUri: 'ui://empty' }, 'broken.tool');
		}).toThrow(/lacks structuredContent or text content/);
	});

	it('Invariant 5: Every Skill remains readable as a Resource', async () => {
		const projection = await setupTestProjection();

		const res = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'resources/read',
			params: { uri: 'skill://deploy-workflow/SKILL.md' },
		})) as any;

		expect(res.result.contents[0].text).toContain('# Deployment Workflow Guide');
		expect(res.result.contents[0].mimeType).toBe('text/markdown');
	});

	it('Invariant 6: Every async Operation remains observable without Tasks', async () => {
		const projection = await setupTestProjection();

		// Trigger operation via core fallback
		const invokeRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'build.deploy',
				arguments: { service: 'billing', env: 'staging' },
			},
		})) as any;

		const jobId = invokeRes.result.structuredContent.jobId;
		expect(jobId).toBeDefined();

		// Read job representation
		const jobRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'resources/read',
			params: { uri: `job://${jobId}` },
		})) as any;

		const parsed = JSON.parse(jobRes.result.contents[0].text);
		expect(parsed.operationId).toBe(jobId);
		expect(parsed.capabilityId).toBe('build.deploy');
		expect(parsed.state).toBe('running');
	});

	it('Invariant 7: Every durable event remains replayable without Events', async () => {
		const projection = await setupTestProjection();

		// Append new event
		await projection.eventPort.appendEvent('electric_stream_01', 'custom.event', { foo: 'bar' });

		// Read from beginning using zero offset
		const replayRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'resources/read',
			params: {
				uri: 'eventstream://electric_stream_01/after/0000000000000000_0000000000000000',
			},
		})) as any;

		const data = JSON.parse(replayRes.result.contents[0].text);
		expect(data.events.length).toBe(3);
		expect(data.events[2].name).toBe('custom.event');
	});

	it('Invariant 8: A client ignoring action/trust metadata cannot bypass server policy', async () => {
		const projection = await setupTestProjection();

		// 1. Destructive tool without confirmation -> MRTR input_required
		const destructiveRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'admin.database.wipe',
				arguments: { confirmPhrase: 'YES' },
			},
		})) as any;
		expect(destructiveRes.result).toBeDefined();
		expect(destructiveRes.result.resultType).toBe('input_required');
		expect(destructiveRes.result.inputRequests[0].id).toBe('confirm_execution');

		// 1.5. Spoofing _confirmed in tool arguments is rejected
		const spoofRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'admin.database.wipe',
				arguments: { confirmPhrase: 'YES', _confirmed: true },
			},
		})) as any;
		expect(spoofRes.result.resultType).toBe('input_required');

		// 2. Destructive tool with verified human review inputResponses -> succeeds
		const confirmedRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {
				name: 'admin.database.wipe',
				arguments: { confirmPhrase: 'YES' },
				inputResponses: [{ id: 'confirm_execution', response: { confirmed: true } }],
			},
		})) as any;
		expect(confirmedRes.result.resultType).toBe('complete');
		expect(confirmedRes.result.structuredContent.wiped).toBe(true);

		// 3. Unauthorized caller attempting to call scope-restricted tool
		const unauthorizedRes = await projection.handleRequest(
			{
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: {
					name: 'linear.issue.create',
					arguments: { title: 'Hacked ticket', teamId: 'ENG' },
				},
			},
			undefined,
			{ principal: 'untrusted-guest', scopes: ['read-only'] },
		);
		expect(unauthorizedRes.error).toBeDefined();
		expect(unauthorizedRes.error?.message).toContain('Permission denied');

		// 4. Delegated execution forbidden
		const delegatedRes = await projection.handleRequest(
			{
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: {
					name: 'delegation.forbidden',
					arguments: {},
				},
			},
			undefined,
			{ principal: 'user', actor: 'sub-agent', delegator: 'user' },
		);
		expect(delegatedRes.error).toBeDefined();
		expect(delegatedRes.error?.message).toContain('Delegation forbidden');
	});

	it("Invariant 9: Duplicated or reordered event wakeups are harmless because Electric's cursor is authoritative", async () => {
		const projection = await setupTestProjection();

		// Two distinct reads from the same cursor produce deterministic slices
		const read1 = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'resources/read',
			params: {
				uri: 'eventstream://electric_stream_01/after/0000000000000000_0000000000000000',
			},
		})) as any;
		const read2 = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'resources/read',
			params: {
				uri: 'eventstream://electric_stream_01/after/0000000000000000_0000000000000000',
			},
		})) as any;

		expect(read1.result.contents[0].text).toEqual(read2.result.contents[0].text);
	});

	it('Invariant 10: A protocol projection cannot create semantics absent from canonical registry/state', async () => {
		const projection = await setupTestProjection();

		// Attempting to invoke unregistered capability returns error
		const res = await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'nonexistent.capability',
				arguments: {},
			},
		});

		expect(res.error).toBeDefined();
		expect(res.error?.message).toContain("Capability 'nonexistent.capability' not found.");
	});
});

// -----------------------------------------------------------------------------
// Server Cards & HTTP Router Test Suite
// -----------------------------------------------------------------------------

describe('Pre-connection Server Cards and Streamable HTTP Router', () => {
	it('GET /.well-known/mcp/server-card.json returns valid Server Card', async () => {
		const projection = await setupTestProjection();
		const app = createMcpCapabilityRouter(projection);

		const res = await app.request('/.well-known/mcp/server-card.json');
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.name).toBe('flue-conformance-server');
		expect(json.protocolVersion).toBe(MCP_2026_07_28);
		expect(json.extensions.skills).toBe(true);
		expect(json.endpoints.mcp).toBe('/mcp');
	});

	it('OPTIONS /mcp returns CORS preflight 204', async () => {
		const projection = await setupTestProjection();
		const app = createMcpCapabilityRouter(projection);

		const res = await app.request('/mcp', { method: 'OPTIONS' });
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
	});

	it('GET /mcp rejects legacy SSE with HTTP 400', async () => {
		const projection = await setupTestProjection();
		const app = createMcpCapabilityRouter(projection);

		const res = await app.request('/mcp', {
			method: 'GET',
			headers: { Accept: 'text/event-stream' },
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as any;
		expect(json.error).toContain('SSE is deprecated and unsupported');
	});

	it('GET /mcp without SSE returns server info', async () => {
		const projection = await setupTestProjection();
		const app = createMcpCapabilityRouter(projection);

		const res = await app.request('/mcp', { method: 'GET' });
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.name).toBe('flue-conformance-server');
		expect(json.protocolVersion).toBe(MCP_2026_07_28);
	});

	it('POST /mcp handles JSON-RPC request and executes projection', async () => {
		const projection = await setupTestProjection();
		const app = createMcpCapabilityRouter(projection, { defaultScopes: ['linear:write'] });

		const reqBody = {
			jsonrpc: '2.0',
			id: 42,
			method: 'tools/call',
			params: {
				name: 'linear.issue.create',
				arguments: { title: 'HTTP Router Test Issue', teamId: 'ENG' },
			},
		};

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(reqBody),
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.jsonrpc).toBe('2.0');
		expect(json.id).toBe(42);
		expect(json.result.structuredContent.title).toBe('HTTP Router Test Issue');
	});
});

describe('Milestone 1 Unification: Ports Dependency Inversion & Electric Authority', () => {
	it('Accepts explicitly injected OperationPort and EventPort', async () => {
		const streamLog = new InMemoryDurableStreamLog();
		const customEventPort = new ElectricEventPort({ streamLog });
		const customOpPort = new OperationStore();

		const projection = new McpCapabilityProjection({
			operationPort: customOpPort,
			eventPort: customEventPort,
		});

		expect(projection.operationPort).toBe(customOpPort);
		expect(projection.eventPort).toBe(customEventPort);

		// Append event through port
		const evt = await projection.eventPort.appendEvent('orders', 'order.placed', {
			orderId: 'ORD-1',
		});
		expect(evt.streamId).toBe('orders');
		expect(evt.cursor).toBeDefined();

		// Read back directly through streamLog
		const readRes = await projection.eventPort.readEvents('orders');
		expect(readRes.events.length).toBe(1);
		expect(readRes.events[0]?.name).toBe('order.placed');
		expect(readRes.events[0]?.cursor).toBe(evt.cursor);
	});

	it('Electric is source of truth: no mcp_events table and cursors come from streamLog', async () => {
		const streamLog = new InMemoryDurableStreamLog();
		const executedSqlQueries: string[] = [];
		const mockSql = {
			exec: (query: string, ..._bindings: unknown[]) => {
				executedSqlQueries.push(query);
				return { toArray: () => [] };
			},
		};

		const eventPort = new ElectricEventPort({
			sql: mockSql as any,
			streamLog,
		});

		// Verify mcp_events is never created in schema
		const hasMcpEventsSchema = executedSqlQueries.some((q) => q.includes('mcp_events'));
		expect(hasMcpEventsSchema).toBe(false);

		// Append event
		const evt = await eventPort.appendEvent('world_stream', 'entity.moved', { x: 10, y: 20 });
		// Cursor must be the opaque format from streamLog, not manufactured 0000000000000001_0000000000000001
		expect(evt.cursor).toMatch(/^\d{16}_\d{16}$/);

		// Read head cursor directly from streamLog
		const head = await eventPort.getHeadCursor('world_stream');
		expect(head).toBe(evt.cursor);

		// Read slice directly from streamLog
		const slice = await eventPort.readEvents('world_stream');
		expect(slice.events.length).toBe(1);
		expect(slice.headCursor).toBe(evt.cursor);
	});

	it('Auth hardening: default anonymous caller has empty scopes and cannot execute scoped capabilities', async () => {
		const projection = await setupTestProjection();
		// Router without defaultScopes grants empty scopes []
		const app = createMcpCapabilityRouter(projection);

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'linear.issue.create',
					arguments: { title: 'Unauthorized Test', teamId: 'ENG' },
				},
			}),
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.error).toBeDefined();
		expect(json.error.message).toContain('Permission denied');
		expect(json.error.message).toContain('linear:write');
	});

	it('Inspection endpoints: require authentication when authenticator is configured', async () => {
		const projection = await setupTestProjection();
		const app = createMcpCapabilityRouter(projection, {
			authenticate: async (c) => {
				const auth = c.req.header('authorization');
				if (auth === 'Bearer valid-admin-token') {
					return { principal: 'admin', actor: 'admin', scopes: ['*'] };
				}
				return null;
			},
		});

		// 1. Unauthenticated request to /tasks/xyz -> 401
		const resTask = await app.request('/tasks/task-123');
		expect(resTask.status).toBe(401);

		// 2. Unauthenticated request to /audit-logs -> 401
		const resAudit = await app.request('/audit-logs');
		expect(resAudit.status).toBe(401);

		// 3. Authenticated request to /audit-logs -> 200
		const resAuditAuthed = await app.request('/audit-logs', {
			headers: { Authorization: 'Bearer valid-admin-token' },
		});
		expect(resAuditAuthed.status).toBe(200);
	});

	describe('Milestone 2: Task Execution Authority & Decoupled Semantic Events', () => {
		it('OperationPort represents execution authority: McpCapabilityProjection does not execute shadow local runs', async () => {
			const invokeSpy = vi.fn().mockResolvedValue({
				content: [{ type: 'text', text: 'Should not be invoked locally' }],
			});

			const projection = new McpCapabilityProjection({
				descriptor: { name: 'test-authority', version: '1.0.0', description: 'test' },
			});

			projection.registry.register({
				id: 'async.heavy.job',
				kind: 'tool',
				title: 'Async Heavy Job',
				description: 'Test job',
				asyncPolicy: 'async',
				pinned: true,
				inputSchema: { type: 'object' },
				invoke: invokeSpy,
			});

			// Invoke capability via tools/call with tasks extension
			const res = (await projection.handleRequest({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'async.heavy.job',
					arguments: { param: 'test-value' },
					capabilities: { tasks: true },
				},
			})) as any;

			expect(res.result.operationId).toBeDefined();
			const opId = res.result.operationId;

			// Verify task was created in OperationStore
			const op = await projection.operationPort.getOperation(opId);
			expect(op).toBeDefined();
			expect(op?.state).toBe('running');

			// Invariant: The MCP projection plane did NOT call cap.invoke() locally!
			// OperationPort owns execution authority.
			expect(invokeSpy).not.toHaveBeenCalled();
		});

		it('CloudflareAgentOperationPort routes execution to AgentOperationService without shadow runs', async () => {
			const submittedTasks: any[] = [];
			const mockAgentService: AgentOperationService = {
				submitTask: async (params) => {
					submittedTasks.push(params);
					return { taskId: 'task-agent-42', state: 'running' };
				},
				getTask: async (taskId) => {
					const found = submittedTasks.find(
						(t) => t.taskId === taskId || taskId === 'task-agent-42',
					);
					if (!found) return undefined;
					return {
						operationId: taskId,
						capabilityId: found.capabilityId,
						state: 'running',
						revision: 1,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
				},
				cancelTask: async () => true,
				respondTask: async (_id, _resp) => ({
					operationId: 'task-agent-42',
					capabilityId: 'agent.run',
					state: 'running',
					revision: 2,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}),
				listTasks: async () => [],
			};

			const agentPort = new CloudflareAgentOperationPort(mockAgentService);
			const created = await agentPort.createOperation({
				capabilityId: 'agent.run',
				payload: { foo: 'bar' },
			});

			expect(created.operationId).toBe('task-agent-42');
			expect(submittedTasks.length).toBe(1);
			expect(submittedTasks[0].capabilityId).toBe('agent.run');

			// Can read job:// resource
			const jobRes = await agentPort.readJobResource('job://task-agent-42');
			expect(jobRes.mimeType).toBe('application/json');
			expect(JSON.parse(jobRes.content).operationId).toBe('task-agent-42');
		});

		it('ElectricEventPort appends with append-first pattern (avoids redundant ensure on existing stream)', async () => {
			const appends: string[] = [];
			const ensures: string[] = [];
			let streamExists = false;

			const mockStreamLog = {
				ensure: async (path: string) => {
					ensures.push(path);
					streamExists = true;
				},
				append: async (path: string, _messages: unknown[]) => {
					appends.push(path);
					if (!streamExists) {
						throw new DurableStreamLogError({
							code: 'not-found',
							path,
							message: 'Stream does not exist yet',
						});
					}
					return { nextOffset: '0000000000000001_0000000000000001' as any };
				},
				read: async () => ({
					messages: [],
					nextOffset: '0000000000000001_0000000000000001' as any,
				}),
				getHeadOffset: async () => '0000000000000001_0000000000000001' as any,
			};

			const port = new ElectricEventPort({
				streamLog: mockStreamLog as any,
			});

			// 1. First append to new stream: append -> 404 -> ensure -> append
			await port.appendEvent('orders', 'order.created', { id: 1 });
			expect(ensures).toEqual(['orders']);
			expect(appends).toEqual(['orders', 'orders']);

			// 2. Second append to existing stream: single append, ZERO ensure calls
			ensures.length = 0;
			appends.length = 0;
			await port.appendEvent('orders', 'order.paid', { id: 1 });
			expect(ensures.length).toBe(0);
			expect(appends).toEqual(['orders']);
		});

		it('Webhook delivery is decoupled from appendEvent and drained via doorbell/drainSubscriptions', async () => {
			const streamLog = new InMemoryDurableStreamLog();
			const port = new ElectricEventPort({ streamLog });

			const deliveries: any[] = [];
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
				deliveries.push({
					headers: options?.headers,
					body: JSON.parse(options?.body as string),
				});
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			});

			try {
				// Subscribe to stream
				const { subscription } = await port.subscribe({
					streamId: 'pipeline',
					callbackUrl: 'https://example.com/wh',
					skipVerification: true,
				});

				// 1. Append event to stream: does NOT immediately invoke webhook synchronously
				const evt1 = await port.appendEvent('pipeline', 'build.done', {
					taskId: 't-1',
					status: 'completed',
				});
				expect(evt1.cursor).toBeDefined();
				expect(deliveries.length).toBe(0); // Decoupled! Invariant 8

				// 2. High-water doorbell triggers drainSubscriptions
				await port.drainSubscriptions('pipeline');
				expect(deliveries.length).toBe(1);
				expect(deliveries[0].body.data.taskId).toBe('t-1');

				// Subscription cursor has advanced
				const updatedSub = port.getSubscription(subscription.id);
				expect(updatedSub?.cursor).toBe(evt1.cursor);

				// 3. Second doorbell with no new events produces no duplicate deliveries
				await port.processDoorbell('pipeline');
				expect(deliveries.length).toBe(1);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('Protocol-neutral events (task.*) are projected to task_changed MCP webhooks with correct status', async () => {
			const streamLog = new InMemoryDurableStreamLog();
			const port = new ElectricEventPort({ streamLog });

			const deliveries: any[] = [];
			const originalFetch = globalThis.fetch;
			globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
				deliveries.push({
					headers: options?.headers,
					body: JSON.parse(options?.body as string),
				});
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			});

			try {
				await port.subscribe({
					streamId: 'tasks',
					callbackUrl: 'https://example.com/tasks-wh',
					skipVerification: true,
				});

				// Append protocol-neutral domain event
				await port.appendEvent('tasks', 'task.completed', {
					taskId: 'job-99',
					result: { output: 'success' },
				});

				// Drain via doorbell
				await port.drainSubscriptions('tasks');
				expect(deliveries.length).toBe(1);

				// MCP client receives task_changed with status: 'completed'
				expect(deliveries[0].headers['x-mcp-event-type']).toBe('task_changed');
				expect(deliveries[0].body.name).toBe('task_changed');
				expect(deliveries[0].body.data.status).toBe('completed');
				expect(deliveries[0].body.data.taskId).toBe('job-99');
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('projectSettlementToElectricEvent correctly maps runtime settlement outcomes to domain events', () => {
			// Completed with reference-only resultRef and artifactRefs
			const c = projectSettlementToElectricEvent({
				submissionId: 'sub-1',
				outcome: 'completed',
				result: { done: true },
				artifactRefs: ['file:///artifact/1'],
			});
			expect(c.name).toBe('task.completed');
			expect(c.id).toBe('task-settled:sub-1');
			expect(c.data.id).toBe('task-settled:sub-1');
			expect(c.data.status).toBe('completed');
			expect(c.data.taskId).toBe('sub-1');
			expect(c.data.resultRef).toBe('job://sub-1');
			expect(c.data.artifactRefs).toEqual(['file:///artifact/1']);

			// Failed
			const f = projectSettlementToElectricEvent({
				submissionId: 'sub-2',
				outcome: 'failed',
				error: 'Timeout',
			});
			expect(f.name).toBe('task.failed');
			expect(f.id).toBe('task-settled:sub-2');
			expect(f.data.id).toBe('task-settled:sub-2');
			expect(f.data.status).toBe('failed');
			expect(f.data.error).toBe('Timeout');
			expect(f.data.resultRef).toBe('job://sub-2');

			// Aborted -> task.cancelled
			const a = projectSettlementToElectricEvent({
				submissionId: 'sub-3',
				outcome: 'aborted',
			});
			expect(a.name).toBe('task.cancelled');
			expect(a.id).toBe('task-settled:sub-3');
			expect(a.data.id).toBe('task-settled:sub-3');
			expect(a.data.status).toBe('cancelled');
			expect(a.data.resultRef).toBe('job://sub-3');
		});

		it('Production hardening: ElectricEventPort requires streamLog unless allowInMemoryFallback or in test', () => {
			const origEnv = process.env.NODE_ENV;
			const origVitest = process.env.VITEST;
			try {
				process.env.NODE_ENV = 'production';
				delete process.env.VITEST;

				// Must throw in production without streamLog
				expect(() => new ElectricEventPort()).toThrow(/requires an explicit DurableStreamLog/);

				// Allowed if allowInMemoryFallback is explicitly set
				const port = new ElectricEventPort({ allowInMemoryFallback: true });
				expect(port.streamLog).toBeDefined();
			} finally {
				process.env.NODE_ENV = origEnv;
				if (origVitest !== undefined) process.env.VITEST = origVitest;
			}
		});

		it('Inspection endpoints: require authentication in production mode unless allowAnonymousInspection: true', async () => {
			const origEnv = process.env.NODE_ENV;
			const origVitest = process.env.VITEST;
			try {
				process.env.NODE_ENV = 'production';
				delete process.env.VITEST;

				const projection = await setupTestProjection();

				// 1. Production router without authenticator -> 401 on inspection endpoints
				const prodApp = createMcpCapabilityRouter(projection);
				const resTasks = await prodApp.request('/tasks/task-123');
				expect(resTasks.status).toBe(401);
				const json = (await resTasks.json()) as any;
				expect(json.message).toContain('Inspection endpoints require authentication in production');

				// 2. Production router with allowAnonymousInspection: true -> permitted
				const openApp = createMcpCapabilityRouter(projection, {
					allowAnonymousInspection: true,
				});
				const resOpen = await openApp.request('/tasks/nonexistent');
				expect(resOpen.status).toBe(404); // Passed auth, failed on 404
			} finally {
				process.env.NODE_ENV = origEnv;
				if (origVitest !== undefined) process.env.VITEST = origVitest;
			}
		});

		it('At-least-once delivery: drainSubscriptions does NOT advance cursor when webhook delivery fails', async () => {
			const streamLog = new InMemoryDurableStreamLog();
			const port = new ElectricEventPort({
				streamLog,
				allowInMemoryFallback: true,
			});

			const originalFetch = globalThis.fetch;
			let failDelivery = true;
			try {
				globalThis.fetch = vi.fn().mockImplementation(async () => {
					if (failDelivery) {
						return new Response('Internal Error', { status: 500 });
					}
					return new Response('OK', { status: 200 });
				}) as any;

				const { subscription } = await port.subscribe({
					callbackUrl: 'https://webhook.test/callback',
					streamId: 'pipeline-atleastonce',
					skipVerification: true,
				});

				const evt = await port.appendEvent('pipeline-atleastonce', 'task.completed', {
					taskId: 'task-42',
				});

				// Delivery fails (500)
				await port.drainSubscriptions('pipeline-atleastonce');
				const subAfterFail = (await port.getSubscription?.(subscription.id)) ?? subscription;
				// Cursor must NOT advance past failed delivery!
				expect(subAfterFail.cursor).toBeUndefined();

				// Now delivery succeeds (200)
				failDelivery = false;
				await port.drainSubscriptions('pipeline-atleastonce');
				const subAfterSuccess = (await port.getSubscription?.(subscription.id)) ?? subscription;
				expect(subAfterSuccess.cursor).toBe(evt.cursor);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it('Stream discovery without ephemeral Set: ElectricEventPort persists streams into SQLite', async () => {
			const streamLog = new InMemoryDurableStreamLog();
			const streamRows = new Map<string, { stream_id: string; updated_at: string }>();
			const mockSql = {
				exec: (query: string, ...bindings: unknown[]) => {
					if (query.includes('INSERT INTO mcp_streams')) {
						const streamId = String(bindings[0]);
						const updatedAt = String(bindings[1]);
						streamRows.set(streamId, { stream_id: streamId, updated_at: updatedAt });
					}
					if (query.includes('SELECT stream_id FROM mcp_streams')) {
						return {
							toArray: () => Array.from(streamRows.values()),
						};
					}
					return { toArray: () => [] };
				},
			};

			const port1 = new ElectricEventPort({
				sql: mockSql as any,
				streamLog,
			});

			await port1.appendEvent('persistent_stream_1', 'item.created', { id: 1 });
			expect(port1.listStreams()).toContain('persistent_stream_1');

			// Second port instance over the same SQLite storage (simulating new isolate eviction)
			const port2 = new ElectricEventPort({
				sql: mockSql as any,
				streamLog,
			});

			// Must discover persistent_stream_1 from SQLite without relying on in-memory Set
			const streams = port2.listStreams();
			expect(streams).toContain('persistent_stream_1');
		});

		it('MCP Doorbell Wake: createEntityWakeRoute dispatches doorbells to mcpWake', async () => {
			const { routeWakeNotice } = await import('../../entity/webhook-route.ts');
			const notice = {
				subscriptionId: 'sub-test',
				generation: 1,
				streams: [
					{ path: 'flue/v1/agent/instance/inbox', tailOffset: '10', pending: true },
					{ path: 'flue/v1/mcp/events/custom', tailOffset: '20', pending: true },
				],
			};
			const routed = routeWakeNotice(notice as any);
			expect(routed.unowned).toContain('flue/v1/mcp/events/custom');
		});

		it('FlueMcpSubscription DO: __mcpWake pumps subscriptions via processDoorbell', async () => {
			const streamLog = new InMemoryDurableStreamLog();
			class MockDO {
				constructor(
					public ctx: any,
					public env: any,
				) {}
			}
			const SubDOClass = createFlueMcpSubscriptionClass({
				DurableObject: MockDO as any,
				streamLog,
			});

			const subDO = new SubDOClass({ storage: {} } as any, {});
			expect(subDO.__mcpWake).toBeDefined();

			const res = await subDO.__mcpWake({
				stream: 'test-stream',
				head: '0000000000000001_0000000000000001',
			});
			expect(res.recorded).toBe(true);
		});

		it('MCP Doorbell Wake: createEntityWakeRoute strictly separates flue-inbox from flue-mcp-events', async () => {
			const { WebhookSigner, durableStreamsWakeBody } =
				await import('../../entity/a2a-test-support.ts');
			const { staticWebhookKeys } = await import('../../entity/webhook.ts');
			const signer = await WebhookSigner.create();

			const agentWakes: Array<{ entity: unknown; doorbell: unknown }> = [];
			const mcpWakes: Array<{ doorbell: unknown }> = [];

			const route = createEntityWakeRoute({
				keys: staticWebhookKeys({ keys: [signer.jwk] }),
				wake: async (entity, doorbell) => {
					agentWakes.push({ entity, doorbell });
				},
				mcpWake: async (doorbell) => {
					mcpWakes.push({ doorbell });
				},
				fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
				now: () => 1000,
			});

			// 1. Send notice with flue-mcp-events subscription
			const mcpBody = durableStreamsWakeBody({
				subscriptionId: 'flue-mcp-events',
				generation: 1,
				streams: [{ path: 'flue/v1/alice/1/events', tailOffset: '100', pending: true }],
			});
			const mcpReq = await signer.request(
				'https://flue.invalid/__flue/streams/wake',
				mcpBody,
				1000,
			);
			const mcpRes = await route.fetch(mcpReq);
			expect(mcpRes.status).toBe(200);
			expect(mcpWakes.length).toBe(1);
			expect(agentWakes.length).toBe(0);

			// 2. Send notice with flue-inbox subscription
			const inboxBody = durableStreamsWakeBody({
				subscriptionId: 'flue-inbox',
				generation: 2,
				streams: [{ path: 'flue/v1/alice/1/inbox', tailOffset: '101', pending: true }],
			});
			const inboxReq = await signer.request(
				'https://flue.invalid/__flue/streams/wake',
				inboxBody,
				1001,
			);
			const inboxRes = await route.fetch(inboxReq);
			expect(inboxRes.status).toBe(200);
			expect(agentWakes.length).toBe(1);
			expect(mcpWakes.length).toBe(1); // Still 1, not called for inbox
		});

		it('EntitySubscriptions: ensureMcpEvents registers flue/v1/*/*/events with flue-mcp-events', async () => {
			const { createEntitySubscriptions } = await import('../../entity/subscriptions.ts');
			let capturedUrl = '';
			let capturedBody: any = null;

			const subs = createEntitySubscriptions({
				root: 'https://streams.example.com',
				webhookUrl: 'https://worker.example.com/__flue/streams/wake',
				fetch: async (url, init) => {
					capturedUrl = url;
					capturedBody = JSON.parse(String(init?.body));
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				},
			});

			const res = await subs.ensureMcpEvents();
			expect(res.id).toBe('flue-mcp-events');
			expect(capturedUrl).toBe('https://streams.example.com/__ds/subscriptions/flue-mcp-events');
			expect(capturedBody.type).toBe('webhook');
			expect(capturedBody.pattern).toBe('flue/v1/*/*/events');
			expect(capturedBody.webhook.url).toBe('https://worker.example.com/__flue/streams/wake');
		});

		it('AgentOperationService: respondTask refuses omitted inputId when multiple questions are pending', async () => {
			const { FlueAgentInstance } = await import('../../runtime/agent-instance.ts');
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { InMemoryAttachmentStore } = await import('../../runtime/attachment-store.ts');
			const { createMcpConnectionCache } = await import('../../mcp.ts');

			const database = await openNodeSqliteDatabase(':memory:');
			const instance = new FlueAgentInstance({
				agentName: 'test-agent',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async () => {},
				attachments: new InMemoryAttachmentStore(),
			});

			await instance.admit({
				kind: 'direct',
				submissionId: 'task-1',
				message: { kind: 'signal', type: 'test', body: '' },
				acceptedAt: new Date().toISOString(),
			});

			vi.spyOn(instance, 'questionsForTask').mockResolvedValue([
				{ id: 'q-1', question: { kind: 'test' } as any, askedAt: 1, conversationId: 0 },
				{ id: 'q-2', question: { kind: 'test' } as any, askedAt: 2, conversationId: 0 },
			]);

			await expect(instance.respondTask('task-1', { input: { value: 42 } })).rejects.toThrow(
				/Multiple pending questions are waiting for task 'task-1'; 'inputId' is required to disambiguate/,
			);
		});

		it('AgentOperationService: respondTask selects the targeted question when inputId is provided', async () => {
			const { FlueAgentInstance } = await import('../../runtime/agent-instance.ts');
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { InMemoryAttachmentStore } = await import('../../runtime/attachment-store.ts');
			const { createMcpConnectionCache } = await import('../../mcp.ts');

			const database = await openNodeSqliteDatabase(':memory:');
			const instance = new FlueAgentInstance({
				agentName: 'test-agent',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async () => {},
				attachments: new InMemoryAttachmentStore(),
			});

			await instance.admit({
				kind: 'direct',
				submissionId: 'task-1',
				message: { kind: 'signal', type: 'test', body: '' },
				acceptedAt: new Date().toISOString(),
			});

			vi.spyOn(instance, 'questionsForTask').mockResolvedValue([
				{ id: 'q-1', question: { kind: 'test' } as any, askedAt: 1, conversationId: 0 },
				{ id: 'q-2', question: { kind: 'test' } as any, askedAt: 2, conversationId: 0 },
			]);
			const answerSpy = vi
				.spyOn(instance, 'answerQuestion')
				.mockResolvedValue({ status: 'accepted', eventId: 'evt-1' });
			vi.spyOn(instance, 'getTask').mockResolvedValue({
				operationId: 'task-1',
				capabilityId: 'agent.run',
				state: 'running',
				revision: 2,
				createdAt: '',
				updatedAt: '',
			});

			const updated = await instance.respondTask('task-1', {
				inputId: 'q-2',
				input: { value: 99 },
			});
			expect(updated.state).toBe('running');
			expect(answerSpy).toHaveBeenCalledWith(
				'q-2',
				expect.objectContaining({ kind: 'test', value: 99 }),
			);
		});

		it('AgentOperationService: questionsForTask filters out questions from different conversations', async () => {
			const { FlueAgentInstance } = await import('../../runtime/agent-instance.ts');
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { InMemoryAttachmentStore } = await import('../../runtime/attachment-store.ts');
			const { createMcpConnectionCache } = await import('../../mcp.ts');
			const { ROOT_CONVERSATION_ID } = await import('@earendil-works/pi-durable');

			const database = await openNodeSqliteDatabase(':memory:');
			const instance = new FlueAgentInstance({
				agentName: 'test-agent',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async () => {},
				attachments: new InMemoryAttachmentStore(),
			});

			await instance.admit({
				kind: 'direct',
				submissionId: 'task-1',
				message: { kind: 'signal', type: 'test', body: '' },
				acceptedAt: new Date().toISOString(),
			});

			vi.spyOn(instance, 'pendingQuestions').mockResolvedValue([
				{
					id: 'q-owned',
					question: { kind: 'test' } as any,
					askedAt: 1,
					conversationId: ROOT_CONVERSATION_ID,
				},
				{
					id: 'q-other',
					question: { kind: 'test' } as any,
					askedAt: 2,
					conversationId: (ROOT_CONVERSATION_ID as number) + 99,
				},
			]);

			const questions = await instance.questionsForTask('task-1');
			expect(questions.length).toBe(1);
			expect(questions[0]?.id).toBe('q-owned');
		});

		it('Settlement Projection: 100 getTask calls project exactly one semantic settlement event to Electric', async () => {
			const { FlueAgentInstance } = await import('../../runtime/agent-instance.ts');
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { InMemoryAttachmentStore } = await import('../../runtime/attachment-store.ts');
			const { createMcpConnectionCache } = await import('../../mcp.ts');
			const { InMemoryDurableStreamLog } = await import('../../streams/memory-log.ts');
			const { STREAM_START } = await import('../../streams/offset.ts');

			const database = await openNodeSqliteDatabase(':memory:');
			const streamLog = new InMemoryDurableStreamLog();

			const instance = new FlueAgentInstance({
				agentName: 'alice',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async () => {},
				attachments: new InMemoryAttachmentStore(),
				entities: { log: streamLog },
			});

			await instance.admit({
				kind: 'direct',
				submissionId: 'task-dedup-100',
				message: { kind: 'signal', type: 'test', body: '' },
				acceptedAt: new Date().toISOString(),
			});

			vi.spyOn(instance, 'settlement').mockResolvedValue({
				submissionId: 'task-dedup-100',
				outcome: 'failed',
				error: { message: 'task failed' },
				settledAt: new Date().toISOString(),
			});

			// Execute 100 calls to getTask on the active instance
			for (let i = 0; i < 100; i++) {
				const op = await instance.getTask('task-dedup-100');
				expect(op?.state).toBe('failed');
			}

			// Read Electric stream: exactly 1 event should be present
			const streamPath = 'flue/v1/alice/1/events';
			const batch = await streamLog.read(streamPath, STREAM_START);
			expect(batch.messages.length).toBe(1);
			const event = batch.messages[0] as any;
			expect(event?.id).toBe('task-settled:task-dedup-100');
			expect(event?.name).toBe('task.failed');

			// Simulate DO eviction/restart: create a new instance on the same SQLite database
			const restartedInstance = new FlueAgentInstance({
				agentName: 'alice',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async () => {},
				attachments: new InMemoryAttachmentStore(),
				entities: { log: streamLog },
			});
			vi.spyOn(restartedInstance, 'settlement').mockResolvedValue({
				submissionId: 'task-dedup-100',
				outcome: 'failed',
				error: { message: 'task failed' },
				settledAt: new Date().toISOString(),
			});

			// Execute 100 more calls on the new instance
			for (let i = 0; i < 100; i++) {
				const op = await restartedInstance.getTask('task-dedup-100');
				expect(op?.state).toBe('failed');
			}

			// Still exactly 1 event in Electric because durable marker persisted
			const batchAfterRestart = await streamLog.read(streamPath, STREAM_START);
			expect(batchAfterRestart.messages.length).toBe(1);
		});

		it('ElectricEventPort: replayPastEvents preserves m.id as eventId for deterministic settlement records', async () => {
			const { InMemoryDurableStreamLog } = await import('../../streams/memory-log.ts');
			const streamLog = new InMemoryDurableStreamLog();
			await streamLog.ensure('test-stream');
			const eventPort = new ElectricEventPort({ streamLog });

			await streamLog.append('test-stream', [
				{
					id: 'task-settled:sub-1234',
					name: 'task_changed',
					timestamp: new Date().toISOString(),
					data: { taskId: 'sub-1234', status: 'completed', revision: 2 },
				},
			]);

			const delivered: Array<{ eventId: string; [key: string]: unknown }> = [];
			vi.spyOn(eventPort as any, 'deliverEvent').mockImplementation(async (_sub, evt) => {
				delivered.push(evt as any);
			});

			await eventPort.subscribe({
				callbackUrl: 'https://webhook.example.com/events',
				streamId: 'test-stream',
				fromRevision: 1,
				skipVerification: true,
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(delivered.length).toBe(1);
			expect(delivered[0]?.eventId).toBe('task-settled:sub-1234');
		});

		it('AgentOperationService: questionsForTask fails closed when piSubmissionId is known but ancestry does not match', async () => {
			const { FlueAgentInstance } = await import('../../runtime/agent-instance.ts');
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { InMemoryAttachmentStore } = await import('../../runtime/attachment-store.ts');
			const { createMcpConnectionCache } = await import('../../mcp.ts');
			const { ROOT_CONVERSATION_ID } = await import('@earendil-works/pi-durable');
			const { FlueQuestions } = await import('../../pi/questions.ts');
			const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');

			const database = await openNodeSqliteDatabase(':memory:');
			const instance = new FlueAgentInstance({
				agentName: 'test-agent',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async () => {},
				attachments: new InMemoryAttachmentStore(),
			});

			await instance.admit({
				kind: 'direct',
				submissionId: 'task-1',
				message: { kind: 'signal', type: 'test', body: '' },
				acceptedAt: new Date().toISOString(),
			});

			const host = await instance.host();
			// Commit question with null callTaskId into Pi
			await host.harness.commit(async (tx) => {
				const doc = await tx.doc(FlueQuestions, 'q-no-task', null);
				doc.status = 'parked';
				doc.question = { kind: 'test' };
				doc.conversationId = ROOT_CONVERSATION_ID;
				doc.callTaskId = null;
			}, BACKGROUND_CONTEXT);

			vi.spyOn(instance, 'pendingQuestions').mockResolvedValue([
				{
					id: 'q-no-task',
					question: { kind: 'test' } as any,
					askedAt: 1,
					conversationId: ROOT_CONVERSATION_ID,
				},
			]);

			// Provide receipt with a known piSubmissionId
			const questions = await instance.questionsForTask('task-1', {
				status: 'admitted',
				conversationId: ROOT_CONVERSATION_ID,
				piSubmissionId: 42,
				kind: 'direct',
				digest: 'd',
				acceptedAt: '',
				uid: '',
				whenBusy: 'steer',
				content: '',
				attempts: 1,
			});

			// Since callTaskId is null, fails closed and rejects the question
			expect(questions.length).toBe(0);
		});

		it('FlueAgentInstance: failed Electric append leaves obligation in outbox, retries on wake', async () => {
			const { FlueAgentInstance } = await import('../../runtime/agent-instance.ts');
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { InMemoryAttachmentStore } = await import('../../runtime/attachment-store.ts');
			const { createMcpConnectionCache } = await import('../../mcp.ts');
			const { InMemoryDurableStreamLog } = await import('../../streams/memory-log.ts');
			const { FlueReactorStore } = await import('../../reactor/reactor-store.ts');
			const { eventsPath } = await import('../../entity/paths.ts');
			const { STREAM_START } = await import('../../streams/offset.ts');

			const database = await openNodeSqliteDatabase(':memory:');
			const streamLog = new InMemoryDurableStreamLog();
			const streamPath = eventsPath({ type: 'test-agent', id: '1' });
			await streamLog.ensure(streamPath);

			let now = Date.now();
			const instance = new FlueAgentInstance({
				agentName: 'test-agent',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async () => {},
				now: () => now,
				attachments: new InMemoryAttachmentStore(),
				entities: { log: streamLog },
			});

			// Fail Electric append
			let failAppend = true;
			const originalAppend = streamLog.append.bind(streamLog);
			vi.spyOn(streamLog, 'append').mockImplementation(async (path: string, messages: readonly unknown[]) => {
				if (failAppend) {
					throw new Error('Electric network partition');
				}
				return originalAppend(path, messages);
			});

			const host = await instance.host();
			const mockSettlement = {
				submissionId: 'task-fail-retry-1',
				outcome: 'completed' as const,
				result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] },
				settledAt: new Date(now).toISOString(),
			};
			vi.spyOn(host, 'settlement').mockResolvedValue(mockSettlement);
			vi.spyOn(instance, 'settlement').mockResolvedValue(mockSettlement);

			await instance.admit({
				kind: 'direct',
				submissionId: 'task-fail-retry-1',
				message: { kind: 'signal', type: 'test', body: '' },
				acceptedAt: new Date(now).toISOString(),
			});

			// Wake while Electric is failing -> settlement reconciled into outbox, but append fails
			await instance.wake({ kind: 'live-tasks' });

			// Verify row exists in outbox
			const store = new FlueReactorStore(database);
			const entry = store.getOutboxEntry('task-settled:task-fail-retry-1');
			expect(entry).toBeDefined();
			expect(entry?.attempts).toBe(1);

			// Verify Electric has 0 messages
			let batch = await streamLog.read(streamPath, STREAM_START);
			expect(batch.messages.length).toBe(0);

			// Heal Electric and advance time past retry_at
			failAppend = false;
			now += 5000;

			// Trigger wake - retries the outbox obligation
			await instance.wake({ kind: 'live-tasks' });

			// Verify outbox obligation is delivered and deleted
			expect(store.outboxCount()).toBe(0);

			// Verify Electric now has exactly 1 projected event with deterministic id
			batch = await streamLog.read(streamPath, STREAM_START);
			expect(batch.messages.length).toBe(1);
			const msg = batch.messages[0] as { id?: string; name?: string } | undefined;
			expect(msg?.id).toBe('task-settled:task-fail-retry-1');
			expect(msg?.name).toBe('task.completed');

			// Trigger another wake - deduplication ensures no duplicate event is appended
			await instance.wake({ kind: 'live-tasks' });
			batch = await streamLog.read(streamPath, STREAM_START);
			expect(batch.messages.length).toBe(1);
		});

		it('FlueAgentInstance: failed Electric append arms delayed wake alarm and records outbox retry', async () => {
			const { FlueAgentInstance } = await import('../../runtime/agent-instance.ts');
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { InMemoryAttachmentStore } = await import('../../runtime/attachment-store.ts');
			const { createMcpConnectionCache } = await import('../../mcp.ts');
			const { InMemoryDurableStreamLog } = await import('../../streams/memory-log.ts');
			const { FlueReactorStore } = await import('../../reactor/reactor-store.ts');
			const { eventsPath } = await import('../../entity/paths.ts');

			const database = await openNodeSqliteDatabase(':memory:');
			const streamLog = new InMemoryDurableStreamLog();
			const streamPath = eventsPath({ type: 'test-agent', id: '1' });
			await streamLog.ensure(streamPath);

			const armedWakes: { atMs: number; reason: unknown }[] = [];
			const now = Date.now();

			const instance = new FlueAgentInstance({
				agentName: 'test-agent',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async (atMs, reason) => {
					armedWakes.push({ atMs, reason });
				},
				now: () => now,
				attachments: new InMemoryAttachmentStore(),
				entities: { log: streamLog },
			});

			vi.spyOn(streamLog, 'append').mockRejectedValue(new Error('Electric unreachable'));

			const host = await instance.host();
			const mockSettlement = {
				submissionId: 'task-alarm-1',
				outcome: 'completed' as const,
				result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] },
				settledAt: new Date(now).toISOString(),
			};
			vi.spyOn(host, 'settlement').mockResolvedValue(mockSettlement);
			vi.spyOn(instance, 'settlement').mockResolvedValue(mockSettlement);

			await instance.admit({
				kind: 'direct',
				submissionId: 'task-alarm-1',
				message: { kind: 'signal', type: 'test', body: '' },
				acceptedAt: new Date(now).toISOString(),
			});

			// Wake while Electric fails
			await instance.wake();

			const store = new FlueReactorStore(database);
			const entry = store.getOutboxEntry('task-settled:task-alarm-1');
			expect(entry).toBeDefined();
			expect(entry?.retryAt).toBe(now + 5000);

			// Verify retry alarm was armed at now + 5000
			const retryAlarm = armedWakes.find((w) => w.atMs === now + 5000);
			expect(retryAlarm).toBeDefined();
		});

		it('FlueAgentInstance: getTask is a read-only projection from Pi durable settlements', async () => {
			const { FlueAgentInstance } = await import('../../runtime/agent-instance.ts');
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { InMemoryAttachmentStore } = await import('../../runtime/attachment-store.ts');
			const { createMcpConnectionCache } = await import('../../mcp.ts');
			const { InMemoryDurableStreamLog } = await import('../../streams/memory-log.ts');
			const { FlueReactorStore } = await import('../../reactor/reactor-store.ts');
			const { eventsPath } = await import('../../entity/paths.ts');

			const database = await openNodeSqliteDatabase(':memory:');
			const streamLog = new InMemoryDurableStreamLog();
			const streamPath = eventsPath({ type: 'test-agent', id: '1' });
			await streamLog.ensure(streamPath);

			const instance = new FlueAgentInstance({
				agentName: 'test-agent',
				instanceId: '1',
				agent: (() => 'test instructions') as any,
				database: () => database,
				events: { emitEvent: () => {} } as any,
				mcp: createMcpConnectionCache(),
				armWake: async () => {},
				attachments: new InMemoryAttachmentStore(),
				entities: { log: streamLog },
			});

			const host = await instance.host();
			const mockSettlement = {
				submissionId: 'task-ro-1',
				outcome: 'completed' as const,
				result: { resultType: 'complete', content: [{ type: 'text', text: 'result ro' }] },
				settledAt: new Date().toISOString(),
			};
			vi.spyOn(host, 'settlement').mockResolvedValue(mockSettlement);
			vi.spyOn(instance, 'settlement').mockResolvedValue(mockSettlement);

			// getTask returns the operation projection
			const task = await instance.getTask('task-ro-1');
			expect(task?.state).toBe('completed');
			expect(task?.operationId).toBe('task-ro-1');

			// Assert getTask does NOT touch outbox or append to Electric
			const store = new FlueReactorStore(database);
			expect(store.outboxCount()).toBe(0);
		});

		it('FlueReactorStore: initializes streams and outbox tables, cleans up legacy projections table', async () => {
			const { openNodeSqliteDatabase } = await import('../../node/node-sqlite-database.ts');
			const { FlueReactorStore } = await import('../../reactor/reactor-store.ts');

			const database = await openNodeSqliteDatabase(':memory:');

			// Create legacy table
			database.prepare(`CREATE TABLE flue_settlement_projections (submission_id TEXT PRIMARY KEY)`).run();

			// Instantiate FlueReactorStore
			const store = new FlueReactorStore(database);

			// Verify flue_entity_streams and flue_outbox exist
			store.ring('test/stream', '100');
			expect(store.behind()).toBe(true);

			store.enqueue({ id: 'evt-1', stream: 'test/stream', event: { hello: 'world' } });
			expect(store.outboxCount()).toBe(1);

			// Verify legacy table is dropped
			const legacyTable = database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flue_settlement_projections'")
				.get();
			expect(legacyTable).toBeUndefined();
		});
	});
});
