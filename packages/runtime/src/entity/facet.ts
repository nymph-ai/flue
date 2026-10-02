/**
 * The entity facet (docs/cloudflare-native.md rule 5): Chord providers of
 * `EntityMessaging`, `EntityObservation` and `EntityLifecycle` over one
 * `FluePiHost` and the entity streams.
 *
 * Effects are idempotent, not co-committed:
 *
 * - `send`/`publish`/`spawn`/remote `schedule` append ONE event directly to
 *   the target's inbox (or this entity's events stream) — a plain POST, no
 *   outbox around Pi's commit. The event id is deterministic: inside a tool
 *   call (the {@link ENTITY_TOOL_CALL} context value) it is
 *   `{self}/{taskId}/{callId}`, which a `replay: "safe"` rerun after a crash
 *   derives again, so the rerun appends the same event and the receiver,
 *   which admits it under `deriveKeyedSubmissionId(target, eventId)`,
 *   deduplicates it. Spawns and schedules use ids derived from their key.
 * - self-`schedule` and `observe` keep their state in Pi docs
 *   (`schedules.ts`, `observations.ts`).
 */
import {
	type Context,
	type ContextKey,
	defineFacet,
	type Facet,
	type MutableReplicatedState,
} from '@earendil-works/chord';
import { createContextKey } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import type { FluePiHost } from '../pi/host.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import type { A2aDirective, A2aInboxMessage, PublishedEvent } from './events.ts';
import { deliveredFromSchedule, entityMessageJson, parseEntityMessage } from './messages.ts';
import type { ObservationBook } from './observations.ts';
import { entityKey, eventsPath, inboxPath, sameEntity } from './paths.ts';
import { appendAnswer, parseFlueAnswer } from './questions.ts';
import { appendCreating } from './append.ts';
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
export const ENTITY_TOOL_CALL: ContextKey<ToolExecutionApi> =
	createContextKey<ToolExecutionApi>('flue.entity.tool-call');

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
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `inst_sp_${hex.slice(0, 26)}`;
}

/** Message id of a relayed directive: one per (sender, purpose, id), so repeats deduplicate. */
function directiveMessageId(self: EntityRef, purpose: string, id: string): string {
	return `${purpose}:${entityKey(self)}/${id}`;
}

export function createEntityFacet(options: EntityFacetOptions): Facet {
	const { entity: self, log, observations, schedules, subscriptions } = options;

	function defaultId(context: Context, what: string): string {
		const call = context.value(ENTITY_TOOL_CALL);
		if (!call) throw new EntityServiceError(`${what} outside a tool call needs an explicit id.`);
		return `${entityKey(self)}/${call.taskId}/${call.callId}`;
	}

	/** Append one event to `target`'s inbox. A repeat appends the same event; the target admits it once. */
	async function sendEvent(
		target: EntityRef,
		messageId: string,
		message: EntityMessage,
		directive: A2aDirective | undefined,
		context: Context,
	): Promise<SendReceipt> {
		const event: A2aInboxMessage = {
			type: 'flue.a2a.message',
			from: { type: self.type, id: self.id },
			messageId,
			message: entityMessageJson(message),
			...(directive === undefined ? {} : { directive }),
		};
		await appendCreating(log, inboxPath(target), event, context.abortSignal);
		return {
			messageId,
			submissionId: await deriveKeyedSubmissionId(target.type, target.id, messageId),
		};
	}

	const messaging: EntityMessagingService = {
		async send(target, message, sendOptions, context) {
			assertEntity(target, 'A send target');
			const parsed = parseEntityMessage(message);
			const messageId = sendOptions.messageId ?? defaultId(context, 'send');
			return sendEvent(target, messageId, parsed, undefined, context);
		},
		async publish(event, publishOptions, context) {
			const eventId = publishOptions.eventId ?? defaultId(context, 'publish');
			const published: PublishedEvent = {
				type: 'flue.event',
				from: { type: self.type, id: self.id },
				eventId,
				event,
			};
			await appendCreating(log, eventsPath(self), published, context.abortSignal);
			return { eventId };
		},
		async answer(target, questionId, answer, answerOptions, context) {
			assertEntity(target, 'An answer target');
			if (typeof questionId !== 'string' || questionId.length === 0)
				throw new EntityServiceError('An answer needs the question id.');
			const parsed = parseFlueAnswer(answer);
			if (!parsed) {
				throw new EntityServiceError(
					'An answer is {"kind":"codemode-approval","decision":"approve"|"reject","reason"?} or {"kind":"mcp-input","inputResponses":{…}}.',
				);
			}
			const eventId = answerOptions.eventId ?? defaultId(context, 'answer');
			await appendAnswer(log, target, { from: self, questionId, answer: parsed, eventId }, context.abortSignal);
			return { eventId };
		},
	};

	const lifecycle: EntityLifecycleService = {
		async spawn(type, args, context) {
			if (typeof type !== 'string' || type.length === 0)
				throw new EntityServiceError('spawn needs an agent type.');
			if (typeof args.key !== 'string' || args.key.length === 0)
				throw new EntityServiceError('spawn needs a key.');
			const child: EntityRef = { type, id: `${self.id}/${args.key}` };
			const uid = await spawnedUid(child);
			await log.ensure(inboxPath(child));
			await log.ensure(eventsPath(child));
			const message = args.message
				? parseEntityMessage(args.message)
				: { text: `You were spawned by ${self.type} "${self.id}" as "${args.key}".` };
			await sendEvent(
				child,
				directiveMessageId(self, 'spawn', args.key),
				message,
				{
					kind: 'spawn',
					uid,
					...(args.initialData === undefined ? {} : { initialData: args.initialData }),
				},
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
				await sendEvent(
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
			await sendEvent(
				target,
				directiveMessageId(self, `unsched@${attempt}`, scheduleId),
				{ text: '' },
				{ kind: 'cancel-schedule', scheduleId },
				context,
			);
			return true;
		},
	};

	return defineFacet({
		id: 'flue.entity',
		setup(env) {
			const cursors: MutableReplicatedState<ObservationCursors> =
				env.replicatedState<ObservationCursors>({});
			const refresh = async (context: Context) => {
				cursors.replace(context, await observations.cursors(context));
			};
			if (options.cursorSink) options.cursorSink.refresh = refresh;

			const observation: EntityObservationService = {
				cursors,
				async observe(source, observeOptions, context) {
					const result = await observations.observe(source, observeOptions, context);
					if (observeOptions.wake === true && subscriptions)
						await subscriptions.observe(self, [result.path]);
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
