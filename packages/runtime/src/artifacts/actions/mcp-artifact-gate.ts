/**
 * MCP tools/call gate for artifact capabilities (P22-A7).
 *
 * Governed artifact tools never accept a caller-supplied fabricAdmitted flag.
 * Admission is resolved through OperationPort policy via authorizeArtifactActionAsync.
 */

import type { FabricAdmissionVerifier } from './fabric-admission.ts';
import {
	authorizeArtifactActionAsync,
	type AuthorizeContext,
} from './authorize-async.ts';
import type { AuthorizeDecision } from './authorize.ts';
import { verifyViewerToken, type ViewerClaims } from '../auth/tokens.ts';
import type { Capability, CapabilityResult, RequestContext } from '../../mcp-server/types.ts';
import { OperationPortFabricAdmission } from './operation-port-admission.ts';
import type { OperationPort } from '../../mcp-server/ports.ts';

export function isArtifactToolCapability(cap: Capability): boolean {
	if (cap.artifact) return true;
	return cap.id.startsWith('artifact.') || cap.id.startsWith('admin.');
}

export function capabilityRequiresFabricAdmission(cap: Capability): boolean {
	if (cap.artifact?.requiresFabricAdmission === true) return true;
	if (cap.artifact?.requiresFabricAdmission === false) return false;
	const effects = cap.effects ?? {};
	if (effects.moneyMovement || effects.destructive) return true;
	if (cap.id.startsWith('admin.')) return true;
	if (cap.id.startsWith('artifact.') && effects.write !== false) return true;
	return false;
}

export function resolveArtifactIds(
	cap: Capability,
	args: Record<string, unknown>,
): { artifactId: string; tenantId: string } {
	const policy = cap.artifact;
	const artifactId = String(
		(policy?.artifactIdArgument ? args[policy.artifactIdArgument] : undefined) ??
			args.artifactId ??
			policy?.artifactId ??
			'',
	);
	const tenantId = String(
		(policy?.tenantIdArgument ? args[policy.tenantIdArgument] : undefined) ??
			args.tenantId ??
			policy?.tenantId ??
			'',
	);
	return { artifactId, tenantId };
}

export function extractViewerToken(
	toolCallParams: Record<string, unknown> | undefined,
	args: Record<string, unknown>,
	authProof?: string,
): string | undefined {
	const meta = (toolCallParams?._meta ?? {}) as Record<string, unknown>;
	const ui = meta['io.modelcontextprotocol/ui'] as Record<string, unknown> | undefined;
	if (typeof ui?.viewerToken === 'string') return ui.viewerToken;
	if (typeof toolCallParams?.viewerToken === 'string') return toolCallParams.viewerToken;
	if (typeof args.viewerToken === 'string') return args.viewerToken;
	if (authProof && authProof.includes('.')) return authProof;
	return undefined;
}

export function resolveViewerClaims(input: {
	readonly viewerSecret?: string;
	readonly toolCallParams?: Record<string, unknown>;
	readonly args: Record<string, unknown>;
	readonly cap: Capability;
	readonly context: RequestContext;
	readonly nowMs: number;
}): ViewerClaims | null {
	const token = extractViewerToken(input.toolCallParams, input.args, input.context.auth.proof);
	if (input.viewerSecret && token) {
		return verifyViewerToken(input.viewerSecret, token, input.nowMs);
	}
	const { artifactId, tenantId } = resolveArtifactIds(input.cap, input.args);
	if (!artifactId.startsWith('artifact://') || !tenantId) return null;
	const allowed = allowedToolsForCapability(input.cap);
	const granted = input.context.auth.scopes.includes('*')
		? allowed
		: allowed.filter((tool) => input.context.auth.scopes.includes(tool));
	if (!granted.includes(input.cap.id)) return null;
	return {
		artifactId,
		tenantId,
		principal: input.context.auth.principal,
		tools: granted,
		exp: input.nowMs + 60_000,
	};
}

function allowedToolsForCapability(cap: Capability): readonly string[] {
	if (cap.artifact?.allowedTools?.length) return cap.artifact.allowedTools;
	return [cap.id];
}

function appOnlyToolsForCapability(cap: Capability): readonly string[] {
	return cap.artifact?.appOnlyTools ?? [];
}

export function buildAuthorizeContext(input: {
	readonly cap: Capability;
	readonly args: Record<string, unknown>;
	readonly context: RequestContext;
	readonly viewerSecret?: string;
	readonly toolCallParams?: Record<string, unknown>;
	readonly fabricAdmission: FabricAdmissionVerifier;
	readonly isRevoked: (artifactId: string) => boolean;
	readonly nowMs: number;
}): AuthorizeContext {
	const { artifactId, tenantId } = resolveArtifactIds(input.cap, input.args);
	return {
		claims: resolveViewerClaims({
			viewerSecret: input.viewerSecret,
			toolCallParams: input.toolCallParams,
			args: input.args,
			cap: input.cap,
			context: input.context,
			nowMs: input.nowMs,
		}),
		artifactId,
		tenantId,
		toolName: input.cap.id,
		appOnlyTools: appOnlyToolsForCapability(input.cap),
		allowedTools: allowedToolsForCapability(input.cap),
		revoked: input.isRevoked(artifactId),
		requiresFabricAdmission: capabilityRequiresFabricAdmission(input.cap),
		fabricAdmission: input.fabricAdmission,
	};
}

export function authorizeDecisionToCapabilityResult(
	capabilityId: string,
	decision: AuthorizeDecision,
): CapabilityResult {
	return {
		resultType: 'complete',
		isError: true,
		content: [
			{
				type: 'text',
				text: `Artifact action '${capabilityId}' denied: ${decision.code ?? 'UNAUTHORIZED'}`,
			},
		],
		structuredContent: {
			code: decision.code,
			requiresFabricAdmission: decision.requiresFabricAdmission,
		},
	};
}

export async function enforceArtifactToolGate(input: {
	readonly cap: Capability;
	readonly args: Record<string, unknown>;
	readonly context: RequestContext;
	readonly toolCallParams?: Record<string, unknown>;
	readonly viewerSecret?: string;
	readonly operationPort: OperationPort;
	readonly fabricAdmission?: FabricAdmissionVerifier;
	readonly isRevoked?: (artifactId: string) => boolean;
	readonly nowMs?: number;
}): Promise<CapabilityResult | null> {
	if (!isArtifactToolCapability(input.cap)) return null;
	const admission =
		input.fabricAdmission ?? new OperationPortFabricAdmission(input.operationPort);
	const ctx = buildAuthorizeContext({
		cap: input.cap,
		args: input.args,
		context: input.context,
		viewerSecret: input.viewerSecret,
		toolCallParams: input.toolCallParams,
		fabricAdmission: admission,
		isRevoked: input.isRevoked ?? (() => false),
		nowMs: input.nowMs ?? Date.now(),
	});
	const decision = await authorizeArtifactActionAsync(ctx);
	if (decision.allowed) return null;
	return authorizeDecisionToCapabilityResult(input.cap.id, decision);
}
