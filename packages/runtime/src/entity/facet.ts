/**
 * The entity facet (PI_UPGRADE_PLAN.md §2.5): Chord providers of
 * `EntityMessaging`, `EntityObservation` and `EntityLifecycle` over one
 * `FluePiHost` and the `DurableStreamLog`.
 *
 * Every effect is a Pi commit, so it is canonical and replays with the log:
 *
 * - `send`/`publish`/`spawn`/remote `schedule` commit a `flue.a2a.send` or
 *   `flue.publish` entry; `StreamStorage` writes the relay row in the same
 *   SQLite transaction and the relay drainer posts it once the commit is on
 *   the log. Inside a tool call (the {@link ENTITY_TOOL_CALL} context value)
 *   the entry is committed through the tool's own `api.commit`, and a
 *   `flue.a2a.relayed` doc keyed by the message id makes a `replay: "safe"`
 *   rerun commit nothing new.
 * - self-`schedule` and `observe` keep their state in Pi docs
 *   (`schedules.ts`, `observations.ts`).
 */
import {
	type Context,
	type ContextKey,
	defineFacet,
	type Facet,
	type JsonValue,
	type MutableReplicatedState,
} from '@earendil-works/chord';
import { createContextKey } from '@earendil-works/chord/context';
import { type ConversationId, ROOT_CONVERSATION_ID, type ToolExecutionApi, type Tx } from '@earendil-works/pi-durable';
import { A2A_SEND_ENTRY_KIND, type A2aDirective, type A2aSendEntryData, PUBLISH_ENTRY_KIND } from '../pi/a2a-entries.ts';
import type { FluePiHost } from '../pi/host.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import { FlueRelayed } from './docs.ts';
import { deliveredFromSchedule, entityMessageJson, parseEntityMessage } from './messages.ts';
import type { ObservationBook } from './observations.ts';
import { entityKey, eventsPath, inboxPath, sameEntity } from './paths.ts';
import type { ScheduleBook } from './schedules.ts';
import {
	EntityLifecycle,
	type EntityLifecycleService,
	type EntityMessage,
	EntityMessaging,
	type EntityMessagingService,
	EntityObservation,
	type EntityObservationService,
	type EntityRef,
	type ObservationCursors,
	type SendReceipt,
} from './services.ts';

/** The tool invocation a service call runs inside, set by `tools-facet.ts`. */
export const ENTITY_TOOL_CALL: ContextKey<ToolExecutionApi> = createContextKey<ToolExecutionApi>(
	'flue.entity.tool-call',
);

/** Adds and removes explicit streams of this entity's wake subscription (`subscriptions.ts`). */
export interface EntitySubscriptionPort {
	observe(entity: EntityRef, streams: readonly string[]): Promise<void>;
	unobserve(entity: EntityRef, stream: string): Promise<void>;
}

export interface EntityFacetOptions {
	readonly host: FluePiHost;
	readonly entity: EntityRef;
	readonly log: DurableStreamLog;
	readonly observations: ObservationBook;
	readonly schedules: ScheduleBook;
	/** Absent: `observe({ wake: true })` records the flag but subscribes nothing (tests, Node). */
	readonly subscriptions?: EntitySubscriptionPort;
	/** Filled in by the facet: republishes `EntityObservation.cursors` from the Pi docs. */
	readonly cursorSink?: { refresh?: (context: Context) => Promise<void> };
}

export class EntityServiceError extends Error {
	constructor(message: string) {
		super(`[flue] ${message}`);
		this.name = 'EntityServiceError';
	}
}

function assertEntity(value: EntityRef, what: string): void {
	if (
		typeof value !== 'object' ||
		value === null ||
		typeof value.type !== 'string' ||
		value.type.length === 0 ||
		typeof value.id !== 'string' ||
		value.id.length === 0
	) {
		throw new EntityServiceError(`${what} must be { type, id } with non-empty strings.`);
	}
}

/** The uid a spawned child is born with: derived, so its parent knows it before the child runs. */
export async function spawnedUid(child: EntityRef): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`flue-spawn-uid\n${child.type}\n${child.id}`),
	);
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `inst_sp_${hex.slice(0, 26)}`;
}

/** Message id of a relayed directive: one per (sender, purpose, id), so repeats deduplicate. */
function directiveMessageId(self: EntityRef, purpose: string, id: string): string {
	return `${purpose}:${entityKey(self)}/${id}`;
}

export function createEntityFacet(options: EntityFacetOptions): Facet {
	const { host, entity: self, log, observations, schedules, subscriptions } = options;

	/** Commit `change` through the tool call's own commit when inside one. */
	function commit<T>(context: Context, change: (tx: Tx, conversationId: ConversationId) => Promise<T>): Promise<T> {
		const call = context.value(ENTITY_TOOL_CALL);
		if (call) return call.commit((tx) => change(tx, call.conversationId), context);
		return host.harness.commit((tx) => change(tx, ROOT_CONVERSATION_ID), context);
	}

	function defaultId(context: Context, what: string): string {
		const call = context.value(ENTITY_TOOL_CALL);
		if (!call) throw new EntityServiceError(`${what} outside a tool call needs an explicit id.`);
		return `${entityKey(self)}/${call.taskId}/${call.callId}`;
	}

	/** Commit one relayed entry unless `dedupKey` was committed before; `true` when it was. */
	function commitRelayed(
		context: Context,
		dedupKey: string,
		kind: string,
		data: JsonValue,
	): Promise<boolean> {
		return commit(context, async (tx, conversationId) => {
			const relayed = await tx.doc(FlueRelayed, dedupKey, null);
			if (relayed.committed) return true;
			relayed.committed = true;
			await tx.appendEntry(conversationId, { kind, data });
			return false;
		});
	}

	async function relaySend(
		target: EntityRef,
		messageId: string,
		message: EntityMessage,
		directive: A2aDirective | undefined,
		context: Context,
	): Promise<SendReceipt> {
		const data: A2aSendEntryData = {
			target: { type: target.type, id: target.id },
			messageId,
			message: entityMessageJson(message),
			...(directive === undefined ? {} : { directive }),
		};
		const deduplicated = await commitRelayed(
			context,
			`send:${messageId}`,
			A2A_SEND_ENTRY_KIND,
			data as unknown as JsonValue,
		);
		return { messageId, submissionId: await deriveKeyedSubmissionId(target.type, target.id, messageId), deduplicated };
	}

	const messaging: EntityMessagingService = {
		async send(target, message, sendOptions, context) {
			assertEntity(target, 'A send target');
			const parsed = parseEntityMessage(message);
			const messageId = sendOptions.messageId ?? defaultId(context, 'send');
			return relaySend(target, messageId, parsed, undefined, context);
		},
		async publish(event, publishOptions, context) {
			const eventId = publishOptions.eventId ?? defaultId(context, 'publish');
			await commitRelayed(context, `publish:${eventId}`, PUBLISH_ENTRY_KIND, { eventId, event });
			return { eventId };
		},
	};

	const lifecycle: EntityLifecycleService = {
		async spawn(type, args, context) {
			if (typeof type !== 'string' || type.length === 0) throw new EntityServiceError('spawn needs an agent type.');
			if (typeof args.key !== 'string' || args.key.length === 0) throw new EntityServiceError('spawn needs a key.');
			const child: EntityRef = { type, id: `${self.id}/${args.key}` };
			const uid = await spawnedUid(child);
			await log.ensure(inboxPath(child));
			await log.ensure(eventsPath(child));
			const message = args.message
				? parseEntityMessage(args.message)
				: { text: `You were spawned by ${self.type} "${self.id}" as "${args.key}".` };
			await relaySend(
				child,
				directiveMessageId(self, 'spawn', args.key),
				message,
				{ kind: 'spawn', uid, ...(args.initialData === undefined ? {} : { initialData: args.initialData }) },
				context,
			);
			return { ...child, uid };
		},
		async schedule(target, atMs, message, scheduleOptions, context) {
			assertEntity(target, 'A schedule target');
			const { scheduleId } = scheduleOptions;
			if (typeof scheduleId !== 'string' || scheduleId.length === 0) {
				throw new EntityServiceError('schedule needs a scheduleId.');
			}
			if (!Number.isFinite(atMs)) throw new EntityServiceError('schedule needs a finite atMs.');
			const parsed = parseEntityMessage(message);
			if (sameEntity(target, self)) {
				await schedules.arm(scheduleId, atMs, deliveredFromSchedule(scheduleId, parsed), context);
			} else {
				await relaySend(
					target,
					directiveMessageId(self, `sched@${atMs}`, scheduleId),
					parsed,
					{ kind: 'schedule', scheduleId, atMs },
					context,
				);
			}
			return { scheduleId };
		},
		async cancelSchedule(target, scheduleId, context) {
			assertEntity(target, 'A schedule target');
			if (sameEntity(target, self)) return schedules.cancel(scheduleId, context);
			// One cancel per call: a later re-schedule and cancel must not deduplicate against this one.
			const call = context.value(ENTITY_TOOL_CALL);
			const attempt = call ? `${call.taskId}/${call.callId}` : String(Date.now());
			const receipt = await relaySend(
				target,
				directiveMessageId(self, `unsched@${attempt}`, scheduleId),
				{ text: '' },
				{ kind: 'cancel-schedule', scheduleId },
				context,
			);
			return !receipt.deduplicated;
		},
	};

	return defineFacet({
		id: 'flue.entity',
		setup(env) {
			const cursors: MutableReplicatedState<ObservationCursors> = env.replicatedState<ObservationCursors>({});
			const refresh = async (context: Context) => {
				cursors.replace(context, await observations.cursors(context));
			};
			if (options.cursorSink) options.cursorSink.refresh = refresh;

			const observation: EntityObservationService = {
				cursors,
				async observe(source, observeOptions, context) {
					const result = await observations.observe(source, observeOptions, context);
					if (observeOptions.wake === true && subscriptions) await subscriptions.observe(self, [result.path]);
					await refresh(context);
					return { key: result.key, offset: result.offset };
				},
				async poll(key, pollOptions, context) {
					const batch = await observations.poll(key, pollOptions, context);
					await refresh(context);
					return batch;
				},
				async unobserve(key, context) {
					const removed = await observations.unobserve(key, context);
					if (removed?.wake && !removed.stillObserved && subscriptions) {
						await subscriptions.unobserve(self, removed.path);
					}
					await refresh(context);
				},
			};

			env.provide(EntityMessaging, messaging);
			env.provide(EntityObservation, observation);
			env.provide(EntityLifecycle, lifecycle);
		},
	});
}
