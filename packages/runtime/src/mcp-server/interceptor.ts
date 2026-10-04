/**
 * Policy Interceptor Pipeline, Trust/Effects, and Tool Resolution.
 *
 * Implements canonical policy enforcement, trust decoration, and advisory resolve.
 *
 * INVARIANT: Client ignorance of trust/action metadata cannot bypass server policy.
 * Policy and authorization are enforced in this pipeline regardless of client protocol capabilities.
 *
 * Implements Model Run-Time Review (MRTR) per MCP 2026-07-28:
 * - Returns `resultType: "input_required"` with `inputRequests` and `requestState`.
 * - Never returns a JSON-RPC error for user reviews or missing parameters.
 * - Secure human review verification (rejects forged model arguments).
 *
 * Reference: docs/mcp-capability-projection.md § 13, 14, 15, 16
 */

import { AppManager } from './apps.ts';
import type {
	Capability,
	CapabilityResult,
	McpInputRequest,
	McpInputResponse,
	RequestContext,
	ResolveResult,
} from './types.ts';

function findInputResponse(context: RequestContext, requestId: string): unknown {
	if (!context.inputResponses) return undefined;
	if (Array.isArray(context.inputResponses)) {
		const found = context.inputResponses.find((r: McpInputResponse) => r.id === requestId);
		return found ? found.response : undefined;
	}
	return (context.inputResponses as Record<string, unknown>)[requestId];
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
		if (effects.destructive) {
			approvalReasons.push('Destructive operations require explicit confirmation.');
		}
		if (effects.moneyMovement) {
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
			const hasScope = capability.authorization.scopes.every(
				(s) => context.auth.scopes.includes('*') || context.auth.scopes.includes(s),
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
			const hasScope = capability.authorization.scopes.every(
				(s) => context.auth.scopes.includes('*') || context.auth.scopes.includes(s),
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

		// 3. Effects / Review enforcement (MRTR via input_required)
		const effects = capability.effects ?? {};
		const needsReview =
			Boolean(effects.userReviewRequired) ||
			Boolean(effects.destructive) ||
			Boolean(effects.moneyMovement);

		if (needsReview) {
			const reviewResponse = findInputResponse(context, 'confirm_execution');
			const isApproved =
				reviewResponse === true ||
				(reviewResponse &&
					typeof reviewResponse === 'object' &&
					(reviewResponse as Record<string, unknown>).confirmed === true);

			if (!isApproved) {
				if (
					reviewResponse === false ||
					(reviewResponse &&
						typeof reviewResponse === 'object' &&
						(reviewResponse as Record<string, unknown>).confirmed === false)
				) {
					return {
						resultType: 'complete',
						isError: true,
						content: [
							{
								type: 'text',
								text: `Execution of '${capability.id}' rejected by user review.`,
							},
						],
					};
				}

				const reasons: string[] = [];
				if (effects.userReviewRequired) reasons.push('userReviewRequired');
				if (effects.destructive) reasons.push('destructive');
				if (effects.moneyMovement) reasons.push('moneyMovement');

				const requestState = btoa(
					JSON.stringify({
						capabilityId: capability.id,
						arguments: arguments_,
						stage: 'review',
					}),
				);

				return {
					resultType: 'input_required',
					inputRequests: [
						{
							id: 'confirm_execution',
							prompt: `Please confirm execution of '${capability.title}' (${capability.id}). This operation is flagged for: ${reasons.join(', ')}.`,
							schema: {
								type: 'object',
								properties: {
									confirmed: {
										type: 'boolean',
										description: 'Confirm execution after human review.',
									},
								},
								required: ['confirmed'],
							},
							reason: 'user_review_required',
						},
					],
					requestState,
					content: [
						{
							type: 'text',
							text: `Input or confirmation required for '${capability.title}'.`,
						},
					],
				};
			}
		}

		// 4. Schema validation (MRTR missing parameters via input_required)
		if (capability.inputSchema?.required && Array.isArray(capability.inputSchema.required)) {
			const missing: string[] = [];
			for (const reqKey of capability.inputSchema.required as string[]) {
				if (arguments_[reqKey] === undefined || arguments_[reqKey] === null) {
					const responseVal = findInputResponse(context, reqKey);
					if (responseVal !== undefined && responseVal !== null) {
						arguments_[reqKey] = responseVal;
					} else {
						missing.push(reqKey);
					}
				}
			}

			if (missing.length > 0) {
				const inputRequests: McpInputRequest[] = missing.map((reqKey) => ({
					id: reqKey,
					prompt: `Parameter '${reqKey}' is required for '${capability.id}'.`,
					schema: {
						type: 'object',
						properties: {
							[reqKey]: (capability.inputSchema?.properties as Record<string, unknown>)?.[
								reqKey
							] ?? {
								type: 'string',
							},
						},
						required: [reqKey],
					},
					reason: 'missing_required_parameter',
				}));

				const requestState = btoa(
					JSON.stringify({
						capabilityId: capability.id,
						arguments: arguments_,
						stage: 'missing_params',
					}),
				);

				return {
					resultType: 'input_required',
					inputRequests,
					requestState,
					content: [
						{
							type: 'text',
							text: `Missing required parameter(s): ${missing.join(', ')}.`,
						},
					],
				};
			}
		}

		// 5. Invoke capability
		if (!capability.invoke) {
			throw new Error(`Capability '${capability.id}' has no invocation handler.`);
		}

		const result = await capability.invoke(arguments_, context);
		result.resultType = result.resultType ?? 'complete';

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
