/**
 * Canonical types and protocol interfaces for Flue MCP Capability Projection.
 *
 * Flue owns one canonical capability model and projects it into core MCP 2026-07-28
 * plus supported official/experimental extensions (Skills, Tasks, Events, Apps, Variants).
 *
 * Reference: docs/mcp-capability-projection.md
 */

export const MCP_2026_07_28 = '2026-07-28' as const;
export type McpProtocolVersion = typeof MCP_2026_07_28;

export type McpResultType = 'complete' | 'input_required';

export interface McpInputRequest {
	id: string;
	prompt: string;
	schema?: Record<string, unknown>;
	reason?: string;
}

export interface McpInputResponse {
	id: string;
	response: unknown;
}

export type CapabilityKind = 'tool' | 'resource' | 'skill' | 'workflow' | 'event' | 'app';
export type AsyncPolicy = 'sync' | 'async' | 'flexible';

export interface ClientExtensionCapabilities {
	skills?: boolean;
	tasks?: boolean;
	events?: boolean;
	apps?: boolean;
	variants?: boolean | string;
	toolsResolve?: boolean;
	progressiveDiscovery?: boolean;
	[key: string]: unknown;
}

export interface TrustMetadata {
	source: string;
	provenance?: string;
	sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
	untrusted?: boolean;
	evidence?: string;
}

export interface EffectMetadata {
	read?: boolean;
	write?: boolean;
	destructive?: boolean;
	reversible?: boolean;
	idempotent?: boolean;
	externalCommunication?: boolean;
	moneyMovement?: boolean;
	userReviewRequired?: boolean;
}

export interface AppUiDefinition {
	viewUri: string; // e.g. ui://linear/project-view
	description?: string;
	previews?: Array<{ type: string; title: string }>;
}

export interface AuthRequirements {
	scopes?: string[];
	roles?: string[];
	delegationAllowed?: boolean;
}

export interface SearchMetadata {
	tags?: string[];
	category?: string;
	rankingWeight?: number;
	keywords?: string[];
}

export interface VariantOverride {
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
}

export interface CapabilityResource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	read?: (context: RequestContext) => Promise<{ content: string | Uint8Array; mimeType: string }>;
}

export interface CapabilitySkillFile {
	path: string;
	uri: string; // e.g. skill://git-flow/scripts/check.sh
	content: string;
	mimeType?: string;
}

export interface CapabilitySkill {
	name: string;
	description: string;
	uri: string; // e.g. skill://git-flow/SKILL.md
	files: CapabilitySkillFile[];
	entryPoint?: string;
}

export interface AuthContext {
	principal: string;
	actor: string;
	delegator?: string;
	scopes: string[];
	constraints?: Record<string, unknown>;
	proof?: string;
}

export interface ResolvedClientCapabilities {
	protocolVersion: McpProtocolVersion;
	extensions: {
		skills: boolean;
		tasks: boolean;
		events: boolean;
		apps: boolean;
		variants: boolean;
		toolsResolve: boolean;
		progressiveDiscovery: boolean;
	};
	profile: string; // Active profile ID
}

export interface RequestContext {
	requestId?: string;
	auth: AuthContext;
	capabilities: ResolvedClientCapabilities;
	protocolVersion: string;
	profile: ProjectionProfile;
	inputResponses?: Record<string, unknown> | McpInputResponse[];
	waitUntil?: (promise: Promise<unknown>) => void;
}

export interface CapabilityResult {
	resultType?: McpResultType;
	content?: Array<
		| { type: 'text'; text: string }
		| { type: 'image'; data: string; mimeType: string }
		| {
				type: 'resource';
				resource: { uri: string; text?: string; blob?: string; mimeType?: string };
		  }
	>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	resourceLinks?: string[];
	uiUri?: string;
	operationId?: string;
	inputRequests?: McpInputRequest[];
	requestState?: string;
	_meta?: Record<string, unknown>;
}

export interface Capability {
	id: string; // Stable Flue identity, e.g. "linear.issue.create"
	kind: CapabilityKind;
	title: string;
	description: string;
	category?: string;
	pinned?: boolean; // Pinned tools appear directly in default progressive discovery tools/list
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	invoke?: (args: Record<string, unknown>, context: RequestContext) => Promise<CapabilityResult>;
	resources?: CapabilityResource[];
	skills?: CapabilitySkill[];
	ui?: AppUiDefinition;
	asyncPolicy?: AsyncPolicy;
	eventSources?: Array<{ streamId: string; name: string }>;
	searchMetadata?: SearchMetadata;
	trust?: TrustMetadata;
	effects?: EffectMetadata;
	authorization?: AuthRequirements;
	variants?: Record<string, VariantOverride>;
}

export interface ProjectionProfile {
	id: string;
	name: string;
	description: string;
	descriptionOverrides?: Record<string, string>; // capabilityId -> overridden description
	toolFilter?: (cap: Capability) => boolean;
	preferredSkills?: string[];
	resourceFilter?: (resUri: string) => boolean;
	verbosity?: 'minimal' | 'normal' | 'verbose';
}

export interface Operation {
	operationId: string;
	capabilityId: string;
	state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'input_required';
	revision: number;
	summary?: string;
	payload?: Record<string, unknown>;
	result?: CapabilityResult;
	error?: { code: string; message: string; details?: unknown };
	inputRequests?: Array<McpInputRequest>;
	cancellation?: { reason: string; cancelledAt: string };
	createdAt: string;
	updatedAt: string;
}

export interface ElectricEvent {
	eventId: string;
	streamId: string;
	name: string;
	cursor: string; // Opaque monotonic cursor e.g. "0000000000000001_0000000000000001"
	timestamp: string;
	data: unknown;
}

export interface EventDefinition {
	name: string;
	description: string;
	delivery: string[];
	inputSchema: Record<string, unknown>;
	payloadSchema: Record<string, unknown>;
	schema?: Record<string, unknown>;
}

export interface EventSubscription {
	id: string;
	callbackUrl: string;
	secret?: string;
	streamId?: string;
	filter?: Record<string, unknown>;
	cursor?: string;
	createdAt: string;
}

export interface WebhookDeliveryRecord {
	id: string;
	subscriptionId: string;
	eventId: string;
	taskId?: string;
	revision?: number;
	cursor: string;
	statusCode?: number;
	status: 'delivered' | 'failed' | 'success';
	error?: string;
	attempt?: number;
	timestamp: string;
}

export interface AuditLogEntry {
	id: string;
	category: string;
	details: unknown;
	timestamp: string;
}

export interface ServerDescriptor {
	name: string;
	version: string;
	description: string;
	protocolVersion: McpProtocolVersion;
	endpoints: {
		mcp: string;
		serverCard: string;
		events?: string;
	};
	capabilities: {
		tools?: boolean;
		resources?: boolean;
		prompts?: boolean;
		logging?: boolean;
	};
	extensions: {
		skills?: boolean;
		tasks?: boolean;
		events?: boolean;
		apps?: boolean;
		variants?: boolean;
		progressiveDiscovery?: boolean;
	};
	profiles?: string[];
}

export interface SearchResultHit {
	id: string;
	kind: CapabilityKind;
	title: string;
	description: string;
	category?: string;
	score: number;
	links: {
		capabilityUri: string;
		resourceUris?: string[];
		skillUris?: string[];
		uiUri?: string;
	};
}

export interface ResolveResult {
	capabilityId: string;
	normalizedArguments: Record<string, unknown>;
	expectedEffects: EffectMetadata;
	requiresApproval: boolean;
	approvalReasons?: string[];
	schemaValid: boolean;
	validationErrors?: string[];
	estimatedCost?: { credits?: number };
}
