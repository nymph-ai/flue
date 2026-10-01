/**
 * The inbox consumer (docs/cloudflare-native.md rule 4): read one batch of
 * this entity's inbox from a cursor, admit each event through
 * `FluePiHost.admit`, and say where the batch ended. The pump
 * (`pump.ts`) commits the cursor after each batch.
 *
 * Admission is idempotent: the submission id is
 * `deriveKeyedSubmissionId(self.type, self.id, messageId)` (the frozen
 * `sub_ik_` derivation), used as the Pi request id, so a redelivered event —
 * a sender's replayed tool call, a crash before the cursor moved, two
 * overlapping pumps — is admitted once (rule 5).
 *
 * An event is admitted, or — when it can never be (a payload conflict, a
 * spawn of an instance that already exists, a malformed message) — reported
 * and skipped, so one bad event cannot wedge the inbox. Anything else
 * (storage, a closed host) throws before the cursor moves past it.
 */
import type { Context } from '@earendil-works/chord';
import { AgentInstanceExistsError, SubmissionConflictError } from '../errors.ts';
import { type A2aInboxMessage, parseA2aInboxMessage } from './events.ts';
import type { FluePiHost } from '../pi/host.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import { DurableStreamLogError, type DurableStreamLog } from '../streams/log.ts';
import { asStreamOffset, type StreamOffset } from '../streams/offset.ts';
import { deliveredFromEntity, parseEntityMessage } from './messages.ts';
import { entityKey, inboxPath } from './paths.ts';
import type { ScheduleBook } from './schedules.ts';
import type { EntityRef } from './services.ts';

export interface InboxConsumerOptions {
	readonly host: FluePiHost;
	readonly entity: EntityRef;
	readonly log: DurableStreamLog;
	readonly schedules: ScheduleBook;
	readonly now: () => number;
	readonly onReport: (error: unknown) => void;
}

/** One batch of the inbox, handled. */
export interface InboxBatchResult {
	/** Where the batch ended: everything through it is admitted (or skipped). */
	readonly nextOffset: StreamOffset;
	readonly upToDate: boolean;
	/** Events read in the batch. */
	readonly events: number;
	/** Submission ids admitted (or found already admitted). */
	readonly admitted: readonly string[];
	readonly skipped: number;
}

/** The submission a relayed message is admitted as. */
export function inboxSubmissionId(entity: EntityRef, messageId: string): Promise<string> {
	return deriveKeyedSubmissionId(entity.type, entity.id, messageId);
}

/** The schedule key a relayed schedule is kept under: namespaced by its sender. */
export function relayedScheduleKey(from: EntityRef, scheduleId: string): string {
	return `${entityKey(from)}:${scheduleId}`;
}

export class InboxConsumer {
	readonly path: string;
	readonly #options: InboxConsumerOptions;

	constructor(options: InboxConsumerOptions) {
		this.#options = options;
		this.path = inboxPath(options.entity);
	}

	/** Read the batch after `from` and admit every event in it. */
	async batch(from: StreamOffset, context: Context): Promise<InboxBatchResult> {
		const { log, onReport } = this.#options;
		let batch: Awaited<ReturnType<DurableStreamLog['read']>>;
		try {
			batch = await log.read(this.path, asStreamOffset(from));
		} catch (error) {
			if (error instanceof DurableStreamLogError && error.code === 'not-found') {
				return { nextOffset: from, upToDate: true, events: 0, admitted: [], skipped: 0 };
			}
			throw error;
		}
		const admitted: string[] = [];
		let skipped = 0;
		for (const raw of batch.messages) {
			const message = parseA2aInboxMessage(raw);
			if (!message) {
				onReport(new Error(`[flue] Skipped a malformed message on inbox "${this.path}".`));
				skipped++;
				continue;
			}
			const outcome = await this.#handle(message, context);
			if (outcome === 'skipped') skipped++;
			else if (outcome !== undefined) admitted.push(outcome);
		}
		return {
			nextOffset: batch.nextOffset,
			upToDate: batch.upToDate || batch.messages.length === 0,
			events: batch.messages.length,
			admitted,
			skipped,
		};
	}

	/** Admit one message; the submission id, `undefined` for a directive without one, or `skipped`. */
	async #handle(
		message: A2aInboxMessage,
		context: Context,
	): Promise<string | undefined | 'skipped'> {
		const { host, entity, schedules, now, onReport } = this.#options;
		const directive = message.directive;
		let body: ReturnType<typeof parseEntityMessage> | undefined;
		if (directive?.kind !== 'cancel-schedule') {
			try {
				body = parseEntityMessage(message.message);
			} catch (error) {
				onReport(error);
				return 'skipped';
			}
		}
		if (directive?.kind === 'schedule') {
			await schedules.arm(
				relayedScheduleKey(message.from, directive.scheduleId),
				directive.atMs,
				deliveredFromEntity(message.from, message.messageId, body ?? {}, 'schedule.fired'),
				context,
			);
			return undefined;
		}
		if (directive?.kind === 'cancel-schedule') {
			await schedules.cancel(relayedScheduleKey(message.from, directive.scheduleId), context);
			return undefined;
		}
		const submissionId = await inboxSubmissionId(entity, message.messageId);
		const delivered = deliveredFromEntity(
			message.from,
			message.messageId,
			body ?? {},
			directive?.kind === 'spawn' ? 'a2a.spawn' : 'a2a.message',
		);
		try {
			await host.admit(
				{
					submissionId,
					kind: 'dispatch',
					message: delivered,
					acceptedAt: new Date(now()).toISOString(),
					whenBusy: 'followUp',
					...(directive?.kind === 'spawn'
						? {
								uid: null,
								birthUid: directive.uid,
								...(directive.initialData === undefined
									? {}
									: { initialData: directive.initialData }),
							}
						: {}),
				},
				context,
			);
		} catch (error) {
			if (error instanceof SubmissionConflictError || error instanceof AgentInstanceExistsError) {
				onReport(error);
				return 'skipped';
			}
			throw error;
		}
		return submissionId;
	}
}
