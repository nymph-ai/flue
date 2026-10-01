/**
 * The inbox consumer (PI_UPGRADE_PLAN.md §2.5 "Wake"): read this entity's
 * inbox from a persisted cursor, admit each relayed message through
 * `FluePiHost.admit`, advance the cursor, and report `processedThrough`.
 *
 * Admission is idempotent: the submission id is
 * `deriveKeyedSubmissionId(self.type, self.id, messageId)` (the frozen
 * `sub_ik_` derivation), used as the Pi request id, so a redelivered wake, a
 * lost cursor or two overlapping wakes admit every message once. The cursor
 * (`flue_entity_cursors`) is therefore advisory — it saves re-reading, it
 * does not decide what is admitted.
 *
 * A message is admitted, or — when it can never be (a payload conflict, a
 * spawn of an instance that already exists) — reported and skipped, so one
 * bad message cannot wedge the inbox. Anything else (storage, a closed host)
 * throws before the cursor moves past it.
 */
import type { Context } from '@earendil-works/chord';
import { AgentInstanceExistsError, SubmissionConflictError } from '../errors.ts';
import { type A2aInboxMessage, parseA2aInboxMessage } from '../pi/a2a-entries.ts';
import type { FluePiHost } from '../pi/host.ts';
import type { EntityCursorStore } from '../pi/stream-storage.ts';
import { deriveKeyedSubmissionId } from '../runtime/ids.ts';
import { DurableStreamLogError, type DurableStreamLog } from '../streams/log.ts';
import { asStreamOffset, STREAM_START } from '../streams/offset.ts';
import { deliveredFromEntity, parseEntityMessage } from './messages.ts';
import { entityKey, inboxPath } from './paths.ts';
import type { ScheduleBook } from './schedules.ts';
import type { EntityRef } from './services.ts';

export interface InboxConsumerOptions {
	readonly host: FluePiHost;
	readonly entity: EntityRef;
	readonly log: DurableStreamLog;
	readonly cursors: () => EntityCursorStore;
	readonly schedules: ScheduleBook;
	readonly now: () => number;
	readonly onReport: (error: unknown) => void;
}

export interface InboxDrainResult {
	/** The inbox offset everything up to (inclusive) has been handled through. */
	readonly processedThrough: string;
	/** Submission ids admitted (or found already admitted) in this pass. */
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
	#running: Promise<InboxDrainResult> | undefined;

	constructor(options: InboxConsumerOptions) {
		this.#options = options;
		this.path = inboxPath(options.entity);
	}

	get cursorKey(): string {
		return `inbox:${this.path}`;
	}

	/** The persisted cursor (`-1` before anything was read). */
	cursor(): string {
		return this.#options.cursors().get(this.cursorKey) ?? STREAM_START;
	}

	/** Drain the inbox; concurrent callers share one pass. */
	drain(context: Context): Promise<InboxDrainResult> {
		if (this.#running) return this.#running;
		const run = this.#drain(context).finally(() => {
			this.#running = undefined;
		});
		this.#running = run;
		return run;
	}

	async #drain(context: Context): Promise<InboxDrainResult> {
		const { log, onReport } = this.#options;
		let offset = this.cursor();
		const admitted: string[] = [];
		let skipped = 0;
		while (true) {
			let batch: Awaited<ReturnType<DurableStreamLog['read']>>;
			try {
				batch = await log.read(this.path, asStreamOffset(offset));
			} catch (error) {
				if (error instanceof DurableStreamLogError && error.code === 'not-found') break;
				throw error;
			}
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
			if (batch.nextOffset !== offset) {
				offset = batch.nextOffset;
				await this.#options.cursors().set(this.cursorKey, offset);
			}
			if (batch.upToDate || batch.messages.length === 0) break;
		}
		return { processedThrough: offset, admitted, skipped };
	}

	/** Admit one message; the submission id, `undefined` for a directive without one, or `skipped`. */
	async #handle(message: A2aInboxMessage, context: Context): Promise<string | undefined | 'skipped'> {
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
								...(directive.initialData === undefined ? {} : { initialData: directive.initialData }),
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
