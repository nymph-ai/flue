/**
 * McpCapabilityProjection - Core Protocol Projection Engine.
 *
 * Implements the request-scoped capability negotiation and dual-projection router
 * across MCP 2026-07-28 core and extensions (Skills, Tasks, Events, Apps, Variants).
 *
 * Reference: docs/mcp-capability-projection.md
 */

import { AppManager } from './apps.ts';
import { EventProjection } from './events.ts';
import { PolicyInterceptorPipeline } from './interceptor.ts';
import { OperationStore } from './operations.ts';
import { BUILTIN_PROFILES, ProfileResolver } from './profiles.ts';
import { CapabilityRegistry } from './registry.ts';
import { SearchIndex } from './search.ts';
import { ServerCardManager } from './server-card.ts';
import { SkillManager } from './skills.ts';
import type {
	AuthContext,
	Capability,
	CapabilityResult,
	ClientExtensionCapabilities,
	McpProtocolVersion,
	ProjectionProfile,
	RequestContext,
	ResolvedClientCapabilities,
	ServerDescriptor,
} from './types.ts';
import { MCP_2026_07_28 } from './types.ts';

export interface McpJsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface ProjectionOptions {
	descriptor?: Partial<ServerDescriptor>;
	customProfiles?: ProjectionProfile[];
}

export class McpCapabilityProjection {
	public readonly registry: CapabilityRegistry;
	public readonly searchIndex: SearchIndex;
	public readonly profileResolver: ProfileResolver;
	public readonly operationStore: OperationStore;
	public readonly eventProjection: EventProjection;
	public readonly skillManager: SkillManager;
	public readonly appManager: AppManager;
	public readonly pipeline: PolicyInterceptorPipeline;
	public readonly serverCardManager: ServerCardManager;
	public readonly descriptor: ServerDescriptor;

	// Active subscriptions for resources/updated notifications
	private readonly resourceListeners = new Map<string, Set<string>>(); // uri -> set of client listener IDs

	constructor(options?: ProjectionOptions) {
		this.registry = new CapabilityRegistry();
		this.searchIndex = new SearchIndex(this.registry);
		this.profileResolver = new ProfileResolver(options?.customProfiles);
		this.operationStore = new OperationStore();
		this.eventProjection = new EventProjection();
		this.skillManager = new SkillManager(this.registry);
		this.appManager = new AppManager();
		this.pipeline = new PolicyInterceptorPipeline();

		this.descriptor = {
			name: options?.descriptor?.name ?? 'flue-mcp-server',
			version: options?.descriptor?.version ?? '2.0.0',
			description: options?.descriptor?.description ?? 'Flue Capability Projection Server',
			protocolVersion: MCP_2026_07_28,
			endpoints: {
				mcp: options?.descriptor?.endpoints?.mcp ?? '/mcp',
				serverCard:
					options?.descriptor?.endpoints?.serverCard ?? '/.well-known/mcp/server-card.json',
				events: options?.descriptor?.endpoints?.events ?? '/events',
			},
			capabilities: {
				tools: true,
				resources: true,
				prompts: true,
				logging: true,
			},
			extensions: {
				skills: true,
				tasks: true,
				events: true,
				apps: true,
				variants: true,
				progressiveDiscovery: true,
			},
			profiles: Object.keys(BUILTIN_PROFILES),
		};

		this.serverCardManager = new ServerCardManager(this.descriptor);
	}

	/**
	 * Negotiate request-scoped client capabilities.
	 *
	 * INVARIANT: Never remember client extension capabilities across requests.
	 * Never infer capabilities from clientInfo.name.
	 */
	resolveClientCapabilities(
		params?: Record<string, unknown>,
		headers?: Headers | Record<string, string>,
		queryProfile?: string,
	): ResolvedClientCapabilities {
		const rawCaps = (params?.capabilities ?? {}) as ClientExtensionCapabilities;

		// Resolve variant / projection profile
		const requestedVariant =
			typeof params?.variant === 'string'
				? params.variant
				: typeof rawCaps.variants === 'string'
					? (rawCaps.variants as string)
					: undefined;

		const profile = this.profileResolver.resolve({
			requestedVariant,
			headers,
			queryProfile,
		});

		return {
			protocolVersion: MCP_2026_07_28,
			extensions: {
				skills: Boolean(rawCaps.skills),
				tasks: Boolean(rawCaps.tasks),
				events: Boolean(rawCaps.events),
				apps: Boolean(rawCaps.apps),
				variants: Boolean(rawCaps.variants) || requestedVariant !== undefined,
				toolsResolve: Boolean(rawCaps.toolsResolve),
				progressiveDiscovery: rawCaps.progressiveDiscovery !== false,
			},
			profile: profile.id,
		};
	}

	/**
	 * Construct request context.
	 */
	createRequestContext(
		capabilities: ResolvedClientCapabilities,
		auth?: Partial<AuthContext>,
		requestId?: string,
	): RequestContext {
		const profile = this.profileResolver.resolve({
			requestedVariant: capabilities.profile,
		});

		const fullAuth: AuthContext = {
			principal: auth?.principal ?? 'anonymous',
			actor: auth?.actor ?? auth?.principal ?? 'anonymous',
			delegator: auth?.delegator,
			scopes: auth?.scopes ?? ['*'],
			constraints: auth?.constraints,
			proof: auth?.proof,
		};

		return {
			requestId,
			auth: fullAuth,
			capabilities,
			protocolVersion: MCP_2026_07_28,
			profile,
		};
	}

	/**
	 * Dispatch a single MCP JSON-RPC 2.0 request.
	 */
	async handleRequest(
		request: McpJsonRpcRequest,
		headers?: Headers | Record<string, string>,
		auth?: Partial<AuthContext>,
		queryProfile?: string,
	): Promise<McpJsonRpcResponse> {
		const reqId = request.id !== undefined ? request.id : null;

		if (request.jsonrpc !== '2.0') {
			return {
				jsonrpc: '2.0',
				id: reqId,
				error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" },
			};
		}

		// Negotiate capabilities strictly for this request
		const capabilities = this.resolveClientCapabilities(request.params, headers, queryProfile);
		const context = this.createRequestContext(capabilities, auth, String(reqId ?? ''));

		try {
			const result = await this.dispatch(request.method, request.params ?? {}, context);
			return {
				jsonrpc: '2.0',
				id: reqId,
				result,
			};
		} catch (err: unknown) {
			if (err && typeof err === 'object' && 'code' in err) {
				const rpcErr = err as { code: number; message?: string; data?: unknown };
				return {
					jsonrpc: '2.0',
					id: reqId,
					error: {
						code: rpcErr.code,
						message: rpcErr.message ?? 'Internal error',
						...(rpcErr.data !== undefined ? { data: rpcErr.data } : {}),
					},
				};
			}

			const message = err instanceof Error ? err.message : String(err);
			return {
				jsonrpc: '2.0',
				id: reqId,
				error: { code: -32603, message },
			};
		}
	}

	private async dispatch(
		method: string,
		params: Record<string, unknown>,
		context: RequestContext,
	): Promise<unknown> {
		switch (method) {
			case 'initialize':
				return this.handleInitialize(params, context);

			case 'server/discover':
				return this.handleServerDiscover(context);

			case 'tools/list':
				return this.handleToolsList(params, context);

			case 'tools/call':
				return this.handleToolsCall(params, context);

			case 'resources/list':
				return this.handleResourcesList(params, context);

			case 'resources/read':
				return this.handleResourcesRead(params, context);

			case 'resources/templates/list':
				return this.handleResourceTemplatesList(context);

			case 'prompts/list':
				return { prompts: [] };

			case 'prompts/get':
				throw new Error(`Prompt '${String(params.name)}' not found.`);

			case 'subscriptions/listen':
				return this.handleSubscriptionListen(params, context);

			case 'subscriptions/unlisten':
				return this.handleSubscriptionUnlisten(params);

			// ----------------------------------------------------------------------
			// Extension Projections (Conditional on Negotiated Capabilities)
			// ----------------------------------------------------------------------
			case 'skills/list':
				if (!context.capabilities.extensions.skills) {
					throw { code: -32601, message: `Method not found: ${method}` };
				}
				return { skills: this.skillManager.listSkills() };

			case 'skills/get': {
				if (!context.capabilities.extensions.skills) {
					throw { code: -32601, message: `Method not found: ${method}` };
				}
				const skillName = String(params.name ?? '');
				const skill = this.skillManager.getSkillDetails(skillName);
				if (!skill) throw new Error(`Skill '${skillName}' not found.`);
				return { skill };
			}

			case 'tasks/get': {
				if (!context.capabilities.extensions.tasks) {
					throw { code: -32601, message: `Method not found: ${method}` };
				}
				const taskId = String(params.taskId ?? params.id ?? '');
				const op = this.operationStore.getOperation(taskId);
				if (!op) throw new Error(`Task '${taskId}' not found.`);
				return { task: op };
			}

			case 'tasks/cancel': {
				if (!context.capabilities.extensions.tasks) {
					throw { code: -32601, message: `Method not found: ${method}` };
				}
				const taskId = String(params.taskId ?? params.id ?? '');
				const reason = String(params.reason ?? 'Cancelled by caller');
				const ok = this.operationStore.cancelOperation(taskId, reason);
				return { success: ok };
			}

			case 'events/list': {
				if (!context.capabilities.extensions.events) {
					throw { code: -32601, message: `Method not found: ${method}` };
				}
				const streams = this.eventProjection.listStreams();
				return {
					streams: streams.map((s) => ({ streamId: s, headCursor: this.eventProjection.getHeadCursor(s) })),
				};
			}

			case 'events/subscribe': {
				if (!context.capabilities.extensions.events) {
					throw { code: -32601, message: `Method not found: ${method}` };
				}
				return this.handleEventsSubscribe(params);
			}

			case 'events/unsubscribe': {
				if (!context.capabilities.extensions.events) {
					throw { code: -32601, message: `Method not found: ${method}` };
				}
				const subId = String(params.subscriptionId ?? params.id ?? '');
				const ok = this.eventProjection.unsubscribe(subId);
				return { success: ok };
			}

			case 'tools/resolve': {
				if (!context.capabilities.extensions.toolsResolve) {
					throw { code: -32601, message: `Method not found: ${method}` };
				}
				const name = String(params.name ?? '');
				const args = (params.arguments as Record<string, unknown>) ?? {};
				const cap = this.registry.get(name);
				if (!cap) throw new Error(`Tool '${name}' not found.`);
				return this.pipeline.resolve(cap, args, context);
			}

			default:
				throw { code: -32601, message: `Method not found: ${method}` };
		}
	}

	// --------------------------------------------------------------------------
	// Core Method Handlers
	// --------------------------------------------------------------------------

	private handleInitialize(
		_params: Record<string, unknown>,
		context: RequestContext,
	): Record<string, unknown> {
		const ext = context.capabilities.extensions;
		const caps: Record<string, unknown> = {
			tools: { listChanged: true },
			resources: { subscribe: true, listChanged: true },
			prompts: { listChanged: true },
			logging: {},
		};

		if (ext.skills) caps.skills = {};
		if (ext.tasks) caps.tasks = {};
		if (ext.events) caps.events = { subscribe: true, list: true, history: true };
		if (ext.apps) caps.apps = {};
		if (ext.variants) caps.variants = { profiles: this.descriptor.profiles };
		if (ext.toolsResolve) caps.toolsResolve = {};

		return {
			protocolVersion: MCP_2026_07_28,
			serverInfo: {
				name: this.descriptor.name,
				version: this.descriptor.version,
			},
			capabilities: caps,
			profile: context.profile.id,
		};
	}

	private handleServerDiscover(context: RequestContext): Record<string, unknown> {
		return this.serverCardManager.getServerDiscover({
			activeProfile: context.profile.id,
			activeExtensions: context.capabilities.extensions,
		});
	}

	private handleToolsList(
		_params: Record<string, unknown>,
		context: RequestContext,
	): { tools: Array<Record<string, unknown>> } {
		const tools: Array<Record<string, unknown>> = [];

		// 1. Stable Bootstrap Progressive Discovery Meta-Tools (always present)
		tools.push(
			{
				name: 'flue.search',
				description:
					'Search the canonical capability registry and skills for tools, workflows, and documents.',
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Search term or keyword.' },
						kinds: {
							type: 'array',
							items: { type: 'string' },
							description: 'Optional filter by capability kind (tool, skill, resource).',
						},
						category: { type: 'string', description: 'Optional category filter.' },
						limit: { type: 'integer', description: 'Maximum search results (default 20).' },
					},
					required: ['query'],
				},
				annotations: { readOnlyHint: true, title: 'Capability Search' },
			},
			{
				name: 'flue.describe',
				description:
					'Inspect full description, JSON schemas, effects, trust, and authorization for a capability.',
				inputSchema: {
					type: 'object',
					properties: {
						capability: { type: 'string', description: 'The stable capability identity.' },
					},
					required: ['capability'],
				},
				annotations: { readOnlyHint: true, title: 'Capability Describe' },
			},
			{
				name: 'flue.invoke',
				description:
					'Invoke a canonical capability with arguments through the Flue policy and execution pipeline.',
				inputSchema: {
					type: 'object',
					properties: {
						capability: { type: 'string', description: 'The capability identity to invoke.' },
						arguments: { type: 'object', description: 'Arguments payload for the capability.' },
					},
					required: ['capability'],
				},
				annotations: { destructiveHint: false, title: 'Capability Invoke' },
			},
			{
				name: 'flue.categories',
				description: 'List distinct domain categories of capabilities available in the registry.',
				inputSchema: { type: 'object', properties: {} },
				annotations: { readOnlyHint: true, title: 'Capability Categories' },
			},
			{
				name: 'flue.resolve',
				description:
					'Advisory resolution of an invocation without executing side effects (validates schemas and approvals).',
				inputSchema: {
					type: 'object',
					properties: {
						capability: { type: 'string', description: 'Target capability identity.' },
						arguments: { type: 'object', description: 'Invocation arguments to validate.' },
					},
					required: ['capability'],
				},
				annotations: { readOnlyHint: true, title: 'Advisory Resolve' },
			},
			{
				name: 'flue.job.cancel',
				description: 'Cancel an ongoing asynchronous job/operation.',
				inputSchema: {
					type: 'object',
					properties: {
						jobId: { type: 'string', description: 'The operation or job ID.' },
						reason: { type: 'string', description: 'Optional cancellation reason.' },
					},
					required: ['jobId'],
				},
				annotations: { destructiveHint: true, title: 'Cancel Job' },
			},
			{
				name: 'flue.job.respond',
				description: 'Respond to an asynchronous job requiring input or confirmation.',
				inputSchema: {
					type: 'object',
					properties: {
						jobId: { type: 'string', description: 'The operation ID.' },
						input: { description: 'Input response value or object.' },
					},
					required: ['jobId', 'input'],
				},
				annotations: { destructiveHint: false, title: 'Respond to Job' },
			},
			{
				name: 'flue.events.open',
				description: 'Open a durable Electric event stream and obtain the initial cursor.',
				inputSchema: {
					type: 'object',
					properties: {
						streamId: { type: 'string', description: 'Stream identity to access.' },
					},
					required: ['streamId'],
				},
				annotations: { readOnlyHint: true, title: 'Open Event Stream' },
			},
		);

		// 2. Native Capabilities (filtered by active profile)
		const capabilities = this.registry.list();
		for (const cap of capabilities) {
			if (cap.kind !== 'tool' && cap.kind !== 'workflow') continue;
			if (context.profile.toolFilter && !context.profile.toolFilter(cap)) continue;

			const desc = this.profileResolver.getCapabilityDescription(cap, context.profile);
			const toolDef: Record<string, unknown> = {
				name: cap.id,
				description: desc,
				inputSchema: cap.inputSchema ?? { type: 'object', properties: {} },
				annotations: {
					title: cap.title,
					readOnlyHint: cap.effects?.read && !cap.effects?.write,
					destructiveHint: Boolean(cap.effects?.destructive),
					idempotentHint: Boolean(cap.effects?.idempotent),
				},
			};

			// Project UI metadata only when Apps extension is negotiated
			if (context.capabilities.extensions.apps && cap.ui) {
				toolDef.ui = cap.ui;
			}

			tools.push(toolDef);
		}

		return { tools: tools.sort((a, b) => (a.name as string).localeCompare(b.name as string)) };
	}

	private async handleToolsCall(
		params: Record<string, unknown>,
		context: RequestContext,
	): Promise<CapabilityResult> {
		const name = String(params.name ?? '');
		const args = (params.arguments as Record<string, unknown>) ?? {};

		// Meta-tools handling
		if (name === 'flue.search') {
			const query = String(args.query ?? '');
			const kinds = Array.isArray(args.kinds) ? (args.kinds as any) : undefined;
			const category = args.category ? String(args.category) : undefined;
			const limit = typeof args.limit === 'number' ? args.limit : 20;

			const hits = this.searchIndex.search({ query, kinds, category, limit });
			return {
				content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }],
				structuredContent: { query, totalHits: hits.length, hits },
			};
		}

		if (name === 'flue.describe') {
			const capId = String(args.capability ?? '');
			const cap = this.registry.get(capId);
			if (!cap) throw new Error(`Capability '${capId}' not found.`);

			const desc = this.profileResolver.getCapabilityDescription(cap, context.profile);
			const payload = {
				id: cap.id,
				kind: cap.kind,
				title: cap.title,
				description: desc,
				category: cap.category,
				inputSchema: cap.inputSchema,
				outputSchema: cap.outputSchema,
				effects: cap.effects,
				trust: cap.trust,
				authorization: cap.authorization,
				resources: cap.resources?.map((r) => r.uri),
				skills: cap.skills?.map((s) => s.uri),
				ui: cap.ui,
			};
			return {
				content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
				structuredContent: payload,
			};
		}

		if (name === 'flue.invoke') {
			const capId = String(args.capability ?? '');
			const capArgs = (args.arguments as Record<string, unknown>) ?? {};
			return this.invokeCapability(capId, capArgs, context);
		}

		if (name === 'flue.categories') {
			const categories = this.registry.getCategories();
			return {
				content: [{ type: 'text', text: JSON.stringify(categories, null, 2) }],
				structuredContent: { categories },
			};
		}

		if (name === 'flue.resolve') {
			const capId = String(args.capability ?? '');
			const capArgs = (args.arguments as Record<string, unknown>) ?? {};
			const cap = this.registry.get(capId);
			if (!cap) throw new Error(`Capability '${capId}' not found.`);

			const resolved = await this.pipeline.resolve(cap, capArgs, context);
			return {
				content: [{ type: 'text', text: JSON.stringify(resolved, null, 2) }],
				structuredContent: resolved as unknown as Record<string, unknown>,
			};
		}

		if (name === 'flue.job.cancel') {
			const jobId = String(args.jobId ?? '');
			const reason = String(args.reason ?? 'Cancelled by user');
			const ok = this.operationStore.cancelOperation(jobId, reason);
			return {
				content: [{ type: 'text', text: ok ? `Job '${jobId}' cancelled.` : `Failed to cancel '${jobId}'.` }],
				structuredContent: { jobId, success: ok },
			};
		}

		if (name === 'flue.job.respond') {
			const jobId = String(args.jobId ?? '');
			const input = args.input;
			const op = this.operationStore.respondOperation(jobId, { input });
			return {
				content: [{ type: 'text', text: `Response delivered to '${jobId}'. State: ${op.state}` }],
				structuredContent: { jobId, state: op.state },
			};
		}

		if (name === 'flue.events.open') {
			const streamId = String(args.streamId ?? '');
			const headCursor = this.eventProjection.getHeadCursor(streamId);
			const headUri = `eventstream://${streamId}/head`;
			return {
				content: [
					{
						type: 'text',
						text: `Opened stream '${streamId}'. Head cursor: ${headCursor ?? 'empty'}. Resource: ${headUri}`,
					},
				],
				structuredContent: { streamId, headCursor, headUri },
				resourceLinks: [headUri],
			};
		}

		// Native tool invocation
		return this.invokeCapability(name, args, context);
	}

	private async invokeCapability(
		capabilityId: string,
		args: Record<string, unknown>,
		context: RequestContext,
	): Promise<CapabilityResult> {
		const cap = this.registry.get(capabilityId);
		if (!cap) {
			throw new Error(`Capability '${capabilityId}' not found.`);
		}

		// Handle asynchronous capabilities
		if (cap.asyncPolicy === 'async') {
			const op = this.operationStore.createOperation({
				capabilityId: cap.id,
				payload: args,
				state: 'running',
			});

			// If client negotiated Tasks extension, return native task reference
			if (context.capabilities.extensions.tasks) {
				return {
					content: [
						{
							type: 'text',
							text: `Task '${op.operationId}' submitted for '${cap.title}'.`,
						},
					],
					structuredContent: {
						taskId: op.operationId,
						status: op.state,
					},
					operationId: op.operationId,
				};
			}

			// Core fallback: return job:// resource handle
			return this.operationStore.projectJobFallbackResult(op);
		}

		// Execute through the common policy interceptor pipeline
		return this.pipeline.execute(cap, args, context);
	}

	private handleResourcesList(
		_params: Record<string, unknown>,
		context: RequestContext,
	): { resources: Array<Record<string, unknown>> } {
		const resources: Array<Record<string, unknown>> = [];

		// 1. Skill resources (canonical SKILL.md and assets)
		const skillResources = this.skillManager.listSkillResources();
		resources.push(...skillResources);

		// 2. Capability descriptors (capability://<id>)
		for (const cap of this.registry.list()) {
			resources.push({
				uri: `capability://${cap.id}`,
				name: `${cap.title} Descriptor`,
				description: `Capability descriptor and schema metadata for ${cap.id}`,
				mimeType: 'application/json',
			});
		}

		// 3. Category descriptors (category://<name>)
		for (const cat of this.registry.getCategories()) {
			resources.push({
				uri: `category://${cat}`,
				name: `Category: ${cat}`,
				description: `Capabilities grouped under domain '${cat}'`,
				mimeType: 'application/json',
			});
		}

		// 4. Standalone registered resources
		for (const res of this.registry.getAllResources()) {
			resources.push({
				uri: res.uri,
				name: res.name ?? res.uri,
				description: res.description ?? 'Canonical Resource',
				mimeType: res.mimeType ?? 'text/plain',
			});
		}

		// 5. Active jobs (job://<id>)
		for (const op of this.operationStore.listOperations()) {
			resources.push({
				uri: `job://${op.operationId}`,
				name: `Job: ${op.operationId}`,
				description: `Status and results for asynchronous operation '${op.operationId}' (${op.state})`,
				mimeType: 'application/json',
			});
		}

		// 6. Active event streams (eventstream://<streamId>/head)
		for (const streamId of this.eventProjection.listStreams()) {
			resources.push({
				uri: `eventstream://${streamId}/head`,
				name: `EventStream Head: ${streamId}`,
				description: `Head cursor and metadata for durable stream '${streamId}'`,
				mimeType: 'application/json',
			});
		}

		// 7. UI views (only if Apps extension is active or requested)
		if (context.capabilities.extensions.apps) {
			resources.push(...this.appManager.listUiResources());
		}

		return {
			resources: resources.sort((a, b) => (a.uri as string).localeCompare(b.uri as string)),
		};
	}

	private async handleResourcesRead(
		params: Record<string, unknown>,
		context: RequestContext,
	): Promise<{ contents: Array<{ uri: string; mimeType: string; text?: string; blob?: string }> }> {
		const uri = String(params.uri ?? '');

		// 1. Skill URI: skill://<name>/<path>
		if (uri.startsWith('skill://')) {
			const res = this.skillManager.readSkillResource(uri);
			return { contents: [{ uri, mimeType: res.mimeType, text: res.content }] };
		}

		// 2. Capability Descriptor URI: capability://<id>
		if (uri.startsWith('capability://')) {
			const capId = uri.slice('capability://'.length);
			const cap = this.registry.get(capId);
			if (!cap) throw new Error(`Capability '${capId}' not found.`);
			const desc = this.profileResolver.getCapabilityDescription(cap, context.profile);
			return {
				contents: [
					{
						uri,
						mimeType: 'application/json',
						text: JSON.stringify(
							{
								id: cap.id,
								kind: cap.kind,
								title: cap.title,
								description: desc,
								category: cap.category,
								inputSchema: cap.inputSchema,
								outputSchema: cap.outputSchema,
								effects: cap.effects,
								trust: cap.trust,
								authorization: cap.authorization,
							},
							null,
							2,
						),
					},
				],
			};
		}

		// 3. Category URI: category://<name>
		if (uri.startsWith('category://')) {
			const category = uri.slice('category://'.length);
			const caps = this.registry.list({ category });
			return {
				contents: [
					{
						uri,
						mimeType: 'application/json',
						text: JSON.stringify({ category, capabilities: caps.map((c) => c.id) }, null, 2),
					},
				],
			};
		}

		// 4. Job URI: job://<id>
		if (uri.startsWith('job://')) {
			const res = this.operationStore.readJobResource(uri);
			return { contents: [{ uri, mimeType: res.mimeType, text: res.content }] };
		}

		// 5. EventStream Head URI: eventstream://<streamId>/head
		const headMatch = uri.match(/^eventstream:\/\/([^/]+)\/head$/);
		if (headMatch) {
			const streamId = headMatch[1]!;
			const res = this.eventProjection.readHeadResource(streamId);
			return { contents: [{ uri, mimeType: res.mimeType, text: res.content }] };
		}

		// 6. EventStream Slice URI: eventstream://<streamId>/after/<cursor>
		const afterMatch = uri.match(/^eventstream:\/\/([^/]+)\/after\/(.+)$/);
		if (afterMatch) {
			const streamId = afterMatch[1]!;
			const afterCursor = afterMatch[2]!;
			const res = this.eventProjection.readAfterResource(streamId, afterCursor);
			return { contents: [{ uri, mimeType: res.mimeType, text: res.content }] };
		}

		// 7. App UI URI: ui://<app>/<view>
		if (uri.startsWith('ui://')) {
			const res = this.appManager.readUiResource(uri);
			return { contents: [{ uri, mimeType: res.mimeType, text: res.content }] };
		}

		// 8. Custom registered resource
		const custom = this.registry.getAllResources().find((r) => r.uri === uri);
		if (custom && custom.read) {
			const res = await custom.read(context);
			const text = typeof res.content === 'string' ? res.content : undefined;
			const blob =
				res.content instanceof Uint8Array ? Buffer.from(res.content).toString('base64') : undefined;
			return { contents: [{ uri, mimeType: res.mimeType, text, blob }] };
		}

		throw new Error(`Resource '${uri}' not found.`);
	}

	private handleResourceTemplatesList(_context: RequestContext): {
		resourceTemplates: Array<Record<string, unknown>>;
	} {
		return {
			resourceTemplates: CapabilityRegistry.CANONICAL_RESOURCE_TEMPLATES.map((t) => ({
				uriTemplate: t.uriTemplate,
				name: t.name,
				description: t.description,
				mimeType: t.mimeType,
			})),
		};
	}

	private handleSubscriptionListen(
		params: Record<string, unknown>,
		context: RequestContext,
	): { success: boolean; uri: string } {
		const uri = String(params.uri ?? '');
		const clientId = context.auth.actor;
		let listeners = this.resourceListeners.get(uri);
		if (!listeners) {
			listeners = new Set();
			this.resourceListeners.set(uri, listeners);
		}
		listeners.add(clientId);
		return { success: true, uri };
	}

	private handleSubscriptionUnlisten(params: Record<string, unknown>): {
		success: boolean;
		uri: string;
	} {
		const uri = String(params.uri ?? '');
		this.resourceListeners.delete(uri);
		return { success: true, uri };
	}

	private async handleEventsSubscribe(
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const delivery = (params.delivery as Record<string, unknown>) ?? {};
		const callbackUrl = String(delivery.url ?? params.callbackUrl ?? '');
		const secret = delivery.secret ? String(delivery.secret) : params.secret ? String(params.secret) : undefined;
		const streamId = params.streamId ? String(params.streamId) : undefined;
		const filter = (params.filter ?? params.arguments) as Record<string, unknown> | undefined;
		const cursor = params.cursor ? String(params.cursor) : undefined;
		const skipVerification = Boolean(params.skipVerification);

		if (!callbackUrl) {
			throw new Error('Missing delivery.url or callbackUrl for events/subscribe');
		}

		const { subscription, refreshBefore } = await this.eventProjection.subscribe({
			callbackUrl,
			secret,
			streamId,
			filter,
			cursor,
			skipVerification,
		});

		return {
			id: subscription.id,
			refreshBefore,
			cursor: subscription.cursor ?? null,
			truncated: false,
		};
	}
}
