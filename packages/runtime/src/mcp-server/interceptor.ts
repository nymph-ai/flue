/**
 * Policy Interceptor Pipeline, Trust/Effects, and Tool Resolution.
 *
 * Implements canonical policy enforcement, trust decoration, and advisory resolve.
 *
 * INVARIANT: Client ignorance of trust/action metadata cannot bypass server policy.
 * Policy and authorization are enforced in this pipeline regardless of client protocol capabilities.
 *
 * Reference: docs/mcp-capability-projection.md § 13, 14, 15, 16
 */

import { AppManager } from './apps.ts';
import type {
	Capability,
	CapabilityResult,
	RequestContext,
	ResolveResult,
} from './types.ts';

export class McpElicitationRequiredError extends Error {
	public readonly code = -32001; // MCP input_required / elicitation error code
	public readonly data: {
		prompt: string;
		schema?: Record<string, unknown>;
		reason: string;
	};

	constructor(prompt: string, schema?: Record<string, unknown>, reason = 'user_review_required') {
		super(`Input or user approval required: ${prompt}`);
		this.name = 'McpElicitationRequiredError';
		this.data = { prompt, schema, reason };
	}
}

export class PolicyInterceptorPipeline {
	/**
	 * Advisory resolve of a capability invocation without executing side effects.
	 */
	async resolve(
		capability: Capability,
		arguments_: Record<string, unknown>,
		context: RequestContext,
	): Promise<ResolveResult> {
		const effects = capability.effects ?? { read: true };
		const approvalReasons: string[] = [];

		// Check effects that mandate approval
		if (effects.userReviewRequired) {
			approvalReasons.push('Capability is marked userReviewRequired.');
		}
		if (effects.destructive && !arguments_._confirmed) {
			approvalReasons.push('Destructive operations require explicit confirmation.');
		}
		if (effects.moneyMovement && !arguments_._confirmed) {
			approvalReasons.push('Financial transactions require explicit user confirmation.');
		}

		// Validate schema
		const schemaErrors: string[] = [];
		if (capability.inputSchema?.required && Array.isArray(capability.inputSchema.required)) {
			for (const reqKey of capability.inputSchema.required as string[]) {
				if (arguments_[reqKey] === undefined || arguments_[reqKey] === null) {
					schemaErrors.push(`Missing required parameter: '${reqKey}'`);
				}
			}
		}

		// Check authorization
		if (capability.authorization?.scopes && capability.authorization.scopes.length > 0) {
			const hasScope = capability.authorization.scopes.every((s) =>
				context.auth.scopes.includes(s),
			);
			if (!hasScope) {
				approvalReasons.push(
					`Caller lacks required OAuth scopes: ${capability.authorization.scopes.join(', ')}`,
				);
			}
		}

		return {
			capabilityId: capability.id,
			normalizedArguments: { ...arguments_ },
			expectedEffects: effects,
			requiresApproval: approvalReasons.length > 0,
			approvalReasons: approvalReasons.length > 0 ? approvalReasons : undefined,
			schemaValid: schemaErrors.length === 0,
			validationErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
		};
	}

	/**
	 * Execute a capability through the full interceptor and policy pipeline.
	 */
	async execute(
		capability: Capability,
		arguments_: Record<string, unknown>,
		context: RequestContext,
	): Promise<CapabilityResult> {
		// 1. Authorization check
		if (capability.authorization?.scopes && capability.authorization.scopes.length > 0) {
			const hasScope = capability.authorization.scopes.every((s) =>
				context.auth.scopes.includes(s),
			);
			if (!hasScope) {
				throw new Error(
					`Permission denied: caller '${context.auth.actor}' lacks required scopes [${capability.authorization.scopes.join(', ')}] for capability '${capability.id}'.`,
				);
			}
		}

		// 2. Delegation constraints check
		if (context.auth.delegator && !capability.authorization?.delegationAllowed) {
			throw new Error(
				`Delegation forbidden: capability '${capability.id}' does not allow delegated execution.`,
			);
		}

		// 3. Effects / Review enforcement
		const effects = capability.effects ?? {};
		if (effects.userReviewRequired && !arguments_._confirmed) {
			throw new McpElicitationRequiredError(
				`Please confirm execution of '${capability.title}' (${capability.id}). This action has external side effects.`,
				{
					type: 'object',
					properties: {
						_confirmed: {
							type: 'boolean',
							description: 'Confirm execution after user review.',
						},
					},
					required: ['_confirmed'],
				},
				'user_review_required',
			);
		}

		// 4. Schema validation
		if (capability.inputSchema?.required && Array.isArray(capability.inputSchema.required)) {
			for (const reqKey of capability.inputSchema.required as string[]) {
				if (arguments_[reqKey] === undefined || arguments_[reqKey] === null) {
					throw new McpElicitationRequiredError(
						`Parameter '${reqKey}' is required for '${capability.id}'.`,
						{
							type: 'object',
							properties: {
								[reqKey]:
									(capability.inputSchema.properties as Record<string, unknown>)?.[reqKey] ?? {
										type: 'string',
									},
							},
							required: [reqKey],
						},
						'missing_required_parameter',
					);
				}
			}
		}

		// 5. Invoke capability
		if (!capability.invoke) {
			throw new Error(`Capability '${capability.id}' has no invocation handler.`);
		}

		const result = await capability.invoke(arguments_, context);

		// 6. Assert semantic completeness for App-backed tools (Invariant 4)
		if (capability.ui || result.uiUri) {
			AppManager.assertSemanticCompleteness(result, capability.id);
		}

		// 7. Trust & Output decoration
		const meta = result._meta ?? {};
		meta.flue = {
			capabilityId: capability.id,
			protocolVersion: context.protocolVersion,
			profile: context.profile.id,
			actor: context.auth.actor,
			trust: capability.trust ?? { source: 'flue-system', sensitivity: 'internal' },
			effects: capability.effects ?? { read: true },
			timestamp: new Date().toISOString(),
		};

		return {
			...result,
			_meta: meta,
		};
	}
}
