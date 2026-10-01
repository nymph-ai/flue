/**
 * Flue-owned Pi Durable documents and entry kinds (PI_UPGRADE_PLAN.md §2.1).
 *
 * Every value here is canonical Pi state: it rides the same atomic commits as
 * Pi's own records, so a rebuilt index or a replayed log reproduces it
 * exactly. Kinds are part of the persisted protocol — never rename one; bump
 * `version` with a `migrate` instead.
 */
import type { JsonValue } from '@earendil-works/chord';
import { defineDoc, defineDocFamily, defineEntry } from '@earendil-works/pi-durable';

/** Instance identity recorded once at birth (`admitInstanceContact` semantics). */
export type FlueInstanceState = {
	/** `null` until the first admitted contact creates the instance. */
	uid: string | null;
	createdAt: string | null;
	/** Schema-parsed creation data, wrapped so `undefined` stays representable. */
	initialData?: { value: JsonValue };
};

export const FlueInstance = defineDoc<FlueInstanceState>({
	kind: 'flue.instance',
	version: 1,
	scope: 'session',
	initial: () => ({ uid: null, createdAt: null }),
});

/** Admission lifecycle of one Flue receipt (§3, two-commit admission). */
export type FlueReceiptStatus = 'absent' | 'admitting' | 'admitted';

/** Why Flue itself ended a submission before Pi settled it. */
export type FlueReceiptClassification = 'exceeded_timeout' | 'exhausted_retry_budget';

/**
 * One Flue submission receipt, keyed by the Flue `submissionId`. `absent` is
 * the family's seed value: a receipt that exists durably is always
 * `admitting` or `admitted`.
 */
export type FlueReceiptState = {
	status: FlueReceiptStatus;
	/** Pi `SubmissionId`, set by commit B. Never exposed on the Flue wire. */
	piSubmissionId?: number;
	/** Conversation the submission was admitted into. */
	conversationId: number;
	/** Flue named session (`undefined` = the root session). */
	session?: string;
	kind: 'dispatch' | 'direct';
	/** SHA-256 of the canonical submission identity (`sameSubmissionIdentity`). */
	digest: string;
	acceptedAt: string;
	/** Instance uid echoed on every receipt for this submission. */
	uid: string;
	whenBusy: 'steer' | 'followUp';
	/**
	 * The Pi user content commit B submits, with attachments already replaced
	 * by `flue-attachment:` placeholders. Kept so a crash between commit A and
	 * commit B can be repaired without the caller.
	 */
	content: JsonValue;
	timeoutAt?: number;
	maxAttempts?: number;
	/** Harness opens that found this submission's run still live. */
	attempts: number;
	classification?: FlueReceiptClassification;
	traceCarrier?: { [key: string]: string };
	/**
	 * The delivered message as the public conversation shows it: the
	 * `DeliveredMessage` with attachment bytes replaced by their refs
	 * (`pi/projection.ts` `DisplayMessage`).
	 */
	message?: JsonValue;
};

export const FlueReceipts = defineDocFamily<FlueReceiptState, null>({
	kind: 'flue.receipts',
	version: 1,
	family: true,
	scope: 'session',
	initial: () => ({
		status: 'absent',
		conversationId: 0,
		kind: 'dispatch',
		digest: '',
		acceptedAt: '',
		uid: '',
		whenBusy: 'followUp',
		content: '',
		attempts: 0,
	}),
});

/**
 * The receipts the host must be able to enumerate without scanning the
 * family: `admitting` receipts (repaired on wake) and admitted receipts whose
 * Pi submission may still be live (timeouts and the attempt budget). Settled
 * receipts leave `live` lazily, on the next wake that observes them.
 */
export type FlueReceiptIndexState = {
	admitting: string[];
	live: { [submissionId: string]: number };
	/** Pi submission id → Flue submission id, for `answeredBySubmissionId`. */
	byPiSubmission: { [piSubmissionId: string]: string };
};

export const FlueReceiptIndex = defineDoc<FlueReceiptIndexState>({
	kind: 'flue.receipt-index',
	version: 1,
	scope: 'session',
	initial: () => ({ admitting: [], live: {}, byPiSubmission: {} }),
});

/** Flue named session → ownerless Pi conversation. The root session is `ROOT_CONVERSATION_ID`. */
export type FlueSessionsState = { sessions: { [name: string]: number } };

export const FlueSessions = defineDoc<FlueSessionsState>({
	kind: 'flue.sessions',
	version: 1,
	scope: 'session',
	initial: () => ({ sessions: {} }),
});

/**
 * `usePersistentState` values of the instance, by state name. One session
 * document rather than a family: a render reads every value up front
 * (synchronously, inside the agent function), so the set must be
 * enumerable. Written by the tool (or lifecycle hook) whose callback called
 * the setter, in its own commit.
 */
export type FlueStateValues = { values: { [name: string]: JsonValue } };

export const FlueState = defineDoc<FlueStateValues>({
	kind: 'flue.state',
	version: 1,
	scope: 'session',
	initial: () => ({ values: {} }),
});

/** A self-schedule: admitted with `requestId = "sched:{id}"` when it fires. */
export type FlueScheduleState = {
	atMs: number;
	message: JsonValue;
	status: 'armed' | 'fired' | 'cancelled';
};

export const FlueSchedules = defineDocFamily<FlueScheduleState, null>({
	kind: 'flue.schedules',
	version: 1,
	family: true,
	scope: 'session',
	initial: () => ({ atMs: 0, message: null, status: 'cancelled' }),
});

/** Observation cursor over another entity's stream (§2.5). */
export type FlueObservationState = {
	source: JsonValue;
	offset: string;
	wake: boolean;
	updatedAt: number;
};

export const FlueObservations = defineDocFamily<FlueObservationState, null>({
	kind: 'flue.observations',
	version: 1,
	family: true,
	scope: 'session',
	initial: () => ({ source: null, offset: '-1', wake: false, updatedAt: 0 }),
});

/**
 * Per-conversation delegate profile: present on a conversation a subagent
 * delegation created. System-prompt sections and the `task`/`activate_skill`
 * tools read it to serve the delegate's world instead of the root agent's.
 */
export type FlueProfileState = {
	agent: string;
	instructions?: string;
	skills: string[];
	subagents: string[];
	depth: number;
};

export const FlueProfile = defineDoc<FlueProfileState>({
	kind: 'flue.profile',
	version: 1,
	scope: 'conversation',
	history: 'latest',
	fork: 'current',
	initial: () => ({ agent: '', skills: [], subagents: [], depth: 0 }),
});

/**
 * Lifecycle-hook bookkeeping for one conversation's runs, keyed by the run's
 * first input submission: which deliveries already ran `useAgentStart`, the
 * signals those callbacks appended (injected into every request of the run),
 * response metadata so far, and the continuation count.
 */
export type FlueRunState = {
	started: number[];
	appends: string[];
	/** Messages in the request that first carried the appends (insert position). */
	anchor: number;
	metadata: { [key: string]: JsonValue };
	continuations: number;
};

export type FlueRunsState = { runs: { [runKey: string]: FlueRunState } };

export const FlueRuns = defineDoc<FlueRunsState>({
	kind: 'flue.runs',
	version: 1,
	scope: 'conversation',
	history: 'latest',
	fork: 'initial',
	initial: () => ({ runs: {} }),
});

/** Task-scoped record of the delegation a subagent tool call started. */
export type FlueDelegationState = { taskId: number | null };

export const FlueDelegation = defineDoc<FlueDelegationState>({
	kind: 'flue.delegation',
	version: 1,
	scope: 'task',
	initial: () => ({ taskId: null }),
});

/** `useDataWriter` part: never model-visible. */
export const FlueDataEntry = defineEntry<{ name: string; data: JsonValue }>('flue.data');
/** Response metadata (`useResponseStart`/`useResponseFinish`): never model-visible. */
export const FlueMetadataEntry = defineEntry<{ run: string; metadata: JsonValue }>('flue.metadata');
/** A2A send recorded inside the sending tool's commit; the relay outbox fans it out. */
export const FlueA2ASendEntry = defineEntry<{
	target: { type: string; id: string };
	messageId: string;
	message: JsonValue;
}>('flue.a2a.send');
/** Transactional publish to this entity's public events stream. */
export const FluePublishEntry = defineEntry<{ eventId: string; event: JsonValue }>('flue.publish');
