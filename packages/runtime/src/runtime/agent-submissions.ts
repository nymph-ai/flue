/**
 * Submission admission (PI_UPGRADE_PLAN.md §1 `agent-submissions.ts` row,
 * §7 step 8): the persisted payload of one delivery, its frozen id
 * derivation, creation-data validation and the durability limits. Execution,
 * attempts, leases, joins and recovery are Pi Durable's; admission itself is
 * `pi/receipts.ts` behind `FluePiHost.admit`.
 */
import * as v from 'valibot';
import {
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
} from '../agent-execution-store.ts';
import { InvalidRequestError } from '../errors.ts';
import type { FlueTraceCarrier } from '../execution-interceptor.ts';
import type { Agent, DeliveredMessage } from '../types.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import { deriveKeyedSubmissionId, generateSubmissionId } from './ids.ts';
import { resolveAgentDurability, resolveAgentInitialDataSchema } from './registration.ts';

/**
 * One admitted agent submission — the operational payload for both
 * transports. `kind` records how the submission arrived (`'dispatch'` via
 * `dispatch()`, `'direct'` via the agent HTTP route); a dispatch's
 * `submissionId` is the one on its `DispatchReceipt`.
 */
export interface AgentSubmissionInput {
	readonly kind: 'dispatch' | 'direct';
	readonly submissionId: string;
	readonly agent: string;
	readonly id: string;
	readonly message: DeliveredMessage;
	/**
	 * Instance-creation data riding this submission. Consulted only when the
	 * submission turns out to be the instance's first contact; ignored on
	 * existing instances.
	 */
	readonly initialData?: unknown;
	readonly acceptedAt: string;
	readonly traceCarrier?: FlueTraceCarrier;
}

interface AttachedAgentSubmissionReceipt {
	readonly submissionId: string;
	/** The conversation offset to follow the submission from. */
	readonly offset: string;
	/** The instance uid: minted when this submission created, echoed when it continued. */
	readonly uid: string;
	/** Present when this admission converged on an existing keyed submission. */
	readonly deduplicated?: true;
}

/** Options accompanying one attached (direct) submission admission. */
export interface AttachedAgentSubmissionOptions {
	/** Distributed-trace continuation extracted from the caller's context. */
	readonly traceCarrier?: FlueTraceCarrier;
	/** Instance-creation data; the seed, consulted only when this send creates. */
	readonly initialData?: unknown;
	/**
	 * Send condition (uid ≈ ETag): a string continues only the incarnation
	 * with that uid; `null` creates only when no instance exists; omit to
	 * send unconditionally.
	 */
	readonly uid?: string | null;
	/**
	 * Caller-chosen delivery name: the submission id is derived from it, so a
	 * retried send converges on the original submission instead of admitting
	 * a duplicate.
	 */
	readonly idempotencyKey?: string;
}

export type AttachedAgentSubmissionAdmission = (
	message: DeliveredMessage,
	options?: AttachedAgentSubmissionOptions,
) => Promise<AttachedAgentSubmissionReceipt>;

/**
 * Validate creation data against the agent's `initialData` contract static
 * (when declared) and return the schema-parsed output — the value renders see
 * and the birth record stores.
 */
export function parseCreationData(agent: Agent, initialData: unknown): unknown {
	const schema = resolveAgentInitialDataSchema(agent);
	if (schema === undefined) return initialData;
	const parsed = v.safeParse(schema, initialData);
	if (!parsed.success) {
		throw new InvalidRequestError({
			reason:
				`The agent requires creation data matching its initialData schema: ${parsed.issues
					.map((issue) => issue.message)
					.join('; ')}. ` +
				"Creation data rides the instance's first message ({ initialData, ... } beside the message).",
		});
	}
	return parsed.output;
}

/**
 * The submission's durability limits: the agent's `durability` static (or
 * the defaults, 1 hour and 10 attempts), anchored at admission.
 */
export function submissionLimits(
	agentName: string,
	acceptedAt: string,
): { readonly timeoutAt: number; readonly maxAttempts: number } {
	let timeoutMs = DURABILITY_DEFAULT_TIMEOUT_MS;
	let maxAttempts = DURABILITY_DEFAULT_MAX_ATTEMPTS;
	try {
		const durability = resolveAgentDurability(agentName);
		timeoutMs = durability?.timeoutMs ?? timeoutMs;
		maxAttempts = durability?.maxAttempts ?? maxAttempts;
	} catch {
		// An invalid durability static must not make work unterminable: the
		// defaults apply.
	}
	const accepted = Date.parse(acceptedAt);
	return {
		timeoutAt: (Number.isFinite(accepted) ? accepted : Date.now()) + timeoutMs,
		maxAttempts,
	};
}

export function createDispatchAgentSubmissionInput(input: DispatchInput): AgentSubmissionInput {
	return {
		kind: 'dispatch',
		submissionId: input.submissionId,
		agent: input.agent,
		id: input.id,
		message: input.message,
		...(input.initialData !== undefined ? { initialData: input.initialData } : {}),
		acceptedAt: input.acceptedAt,
	};
}

export async function createDirectAgentSubmissionInput(options: {
	agent: string;
	id: string;
	message: DeliveredMessage;
	initialData?: unknown;
	traceCarrier?: FlueTraceCarrier;
	/** When present, the submission id is derived from it instead of minted. */
	idempotencyKey?: string;
}): Promise<AgentSubmissionInput> {
	return {
		kind: 'direct',
		submissionId:
			options.idempotencyKey !== undefined
				? await deriveKeyedSubmissionId(options.agent, options.id, options.idempotencyKey)
				: generateSubmissionId(),
		agent: options.agent,
		id: options.id,
		message: options.message,
		...(options.initialData !== undefined ? { initialData: options.initialData } : {}),
		acceptedAt: new Date().toISOString(),
		...(options.traceCarrier ? { traceCarrier: options.traceCarrier } : {}),
	};
}
