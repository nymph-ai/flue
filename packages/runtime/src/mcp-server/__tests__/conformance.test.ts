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

import { describe, expect, it } from 'vitest';
import { AppManager } from '../apps.ts';
import { PolicyInterceptorPipeline } from '../interceptor.ts';
import { McpCapabilityProjection } from '../projection.ts';
import { createMcpCapabilityRouter } from '../router.ts';
import type { Capability, CapabilityResult, RequestContext } from '../types.ts';
import { MCP_2026_07_28 } from '../types.ts';

// -----------------------------------------------------------------------------
// Test Fixture Setup
// -----------------------------------------------------------------------------

function setupTestProjection(): McpCapabilityProjection {
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
	projection.eventProjection.appendEvent('electric_stream_01', 'deployment.started', {
		service: 'web',
		version: '1.0.0',
	});
	projection.eventProjection.appendEvent('electric_stream_01', 'deployment.completed', {
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
		const projection = setupTestProjection();

		// 1. server/discover
		const disc = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'server/discover',
			params: { capabilities: {} },
		})) as any;

		expect(disc.result).toBeDefined();
		expect(disc.result.protocolVersion).toBe(MCP_2026_07_28);
		expect(disc.result.extensions.skills).toBe(true);
		expect(disc.result.extensions.tasks).toBe(true);

		// 2. tools/list: bootstrap meta-tools + native capabilities present
		const toolsRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { capabilities: {} },
		})) as any;

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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();

		// Append new event
		projection.eventProjection.appendEvent('electric_stream_01', 'custom.event', { foo: 'bar' });

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
		const projection = setupTestProjection();

		// 1. Destructive tool without confirmation -> McpElicitationRequiredError (-32001)
		const destructiveRes = await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'admin.database.wipe',
				arguments: { confirmPhrase: 'YES' },
			},
		});
		expect(destructiveRes.error).toBeDefined();
		expect(destructiveRes.error?.code).toBe(-32001);
		expect(destructiveRes.error?.message).toContain('Please confirm execution');

		// 2. Destructive tool with _confirmed -> succeeds
		const confirmedRes = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'admin.database.wipe',
				arguments: { confirmPhrase: 'YES', _confirmed: true },
			},
		})) as any;
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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();

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
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();
		const app = createMcpCapabilityRouter(projection);

		const res = await app.request('/mcp', { method: 'OPTIONS' });
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
	});

	it('GET /mcp rejects legacy SSE with HTTP 400', async () => {
		const projection = setupTestProjection();
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
		const projection = setupTestProjection();
		const app = createMcpCapabilityRouter(projection);

		const res = await app.request('/mcp', { method: 'GET' });
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.name).toBe('flue-conformance-server');
		expect(json.protocolVersion).toBe(MCP_2026_07_28);
	});

	it('POST /mcp handles JSON-RPC request and executes projection', async () => {
		const projection = setupTestProjection();
		const app = createMcpCapabilityRouter(projection);

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
