/**
 * Chord service contracts for addressable entities (PI_UPGRADE_PLAN.md §2.5).
 *
 * Every member is JSON in, JSON out, `Context` last, so all three satisfy
 * Chord's `RemoteServiceContract` and could be exported to a remote facet
 * later. Pi never sees what is behind them: `entity/facet.ts` provides them
 * over `FluePiHost` and the entity streams, and `entity/tools-facet.ts` turns
 * them into Pi tools.
 */

import {
	type Context,
	defineService,
	type JsonValue,
	type ReplicatedState,
} from '@earendil-works/chord';

/** A Flue agent instance: agent name + instance id (the Durable Object `idFromName`). */
export type EntityRef = { readonly type: string; readonly id: string };

/** JSON form of a delivered message. `attachments` are not relayed yet. */
export type EntityMessage = {
	readonly text?: string;
	readonly data?: JsonValue;
	readonly attachments?: JsonValue[];
};

export type SendReceipt = {
	readonly messageId: string;
	/** The receiver's submission id: `deriveKeyedSubmissionId(target.type, target.id, messageId)`. */
	readonly submissionId: string;
};

export type ObserveSource =
	{ readonly entity: EntityRef; readonly channel: 'events' } | { readonly stream: string };

export type ObservedBatch = {
	readonly items: readonly JsonValue[];
	readonly nextOffset: string;
	readonly upToDate: boolean;
};

export type ObservationCursors = {
	readonly [key: string]: { readonly offset: string; readonly updatedAt: number };
};

export interface EntityMessagingService {
	/**
	 * Send: appends one event to the target's inbox; the target admits it
	 * with `requestId = submissionId`, once however often it is appended. The
	 * default `messageId` is `{self}/{taskId}/{callId}` inside a tool call
	 * (stable across `replay: "safe"` reruns) and is required outside one.
	 */
	send(
		target: EntityRef,
		message: EntityMessage,
		options: { readonly messageId?: string },
		context: Context,
	): Promise<SendReceipt>;
	/** Append one event to this entity's public events stream (same id rules as `send`). */
	publish(
		event: JsonValue,
		options: { readonly eventId?: string },
		context: Context,
	): Promise<{ readonly eventId: string }>;
}

export interface EntityObservationService {
	/** Start (or keep) observing a stream from a cursor; `wake: true` adds it to this entity's wake subscription. */
	observe(
		source: ObserveSource,
		options: { readonly key: string; readonly from?: string; readonly wake?: boolean },
		context: Context,
	): Promise<{ readonly key: string; readonly offset: string }>;
	/**
	 * Read past the cursor and record each item as a Pi write submission of
	 * entry kind `flue.observed` (`requestId = "obs:{key}@{offset}:{index}"`),
	 * then advance the cursor in the `flue.observations` doc.
	 */
	poll(key: string, options: { readonly limit?: number }, context: Context): Promise<ObservedBatch>;
	unobserve(key: string, context: Context): Promise<void>;
	/** Read-only projection of observation cursors (replicated to UIs/remote facets). */
	readonly cursors: ReplicatedState<ObservationCursors>;
}

export interface EntityLifecycleService {
	/**
	 * Spawn the child `{self.id}/{key}` of `type`: ensure its streams, then
	 * relay a create-only admission (`uid: null`) carrying `initialData`.
	 * Idempotent per key; the uid is derived, so it is known before the child runs.
	 */
	spawn(
		type: string,
		args: {
			readonly key: string;
			readonly initialData?: JsonValue;
			readonly message?: EntityMessage;
		},
		context: Context,
	): Promise<EntityRef & { readonly uid: string }>;
	/**
	 * Admit `message` to `target` at `atMs`. For this entity: the
	 * `flue.schedules` doc plus `armWake`; for another: a relayed schedule
	 * the target arms itself. Fires with `requestId = "sched:{scheduleId}"`.
	 */
	schedule(
		target: EntityRef,
		atMs: number,
		message: EntityMessage,
		options: { readonly scheduleId: string },
		context: Context,
	): Promise<{ readonly scheduleId: string }>;
	cancelSchedule(target: EntityRef, scheduleId: string, context: Context): Promise<boolean>;
}

export const EntityMessaging = defineService<EntityMessagingService>('flue.entity.messaging');
export const EntityObservation = defineService<EntityObservationService>('flue.entity.observation');
export const EntityLifecycle = defineService<EntityLifecycleService>('flue.entity.lifecycle');
