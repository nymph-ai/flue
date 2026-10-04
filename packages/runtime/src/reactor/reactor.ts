/**
 * FlueReactor: the deterministic coordination layer of AgentDO.
 *
 * It coordinates:
 * 1. Inbound Electric streams (pumpEntity)
 * 2. Pi Durable repair & resume (host.wake / entity.wake)
 * 3. Pi settlements → semantic outbox (reconcileSettlements)
 * 4. Flush semantic outbox to Electric (flushOutbox)
 * 5. Schedules and question timeouts
 * 6. Single alarm calculation: nextWake = min(...)
 *
 * Critical Invariant:
 * Pi state is reconciled into durable Flue obligations (INSERT OR IGNORE flue_outbox)
 * before Flue forgets the Pi work that created them (retire from index.live);
 * durable Flue obligations are deleted only after the external system accepts them (DELETE flue_outbox).
 */
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { DurableStreamLog } from '../streams/log.ts';
import { appendCreating } from '../entity/append.ts';
import { eventsPath } from '../entity/paths.ts';
import type { EntityRef } from '../entity/services.ts';
import { type PumpLimits, type PumpResult, pumpEntity } from '../entity/pump.ts';
import type { EntityRuntime } from '../entity/runtime.ts';
import { projectSettlementToElectricEvent } from '../mcp-server/events.ts';
import { FlueReactorStore } from './reactor-store.ts';
import {
	type FluePiHost,
	LIVE_TASK_BACKSTOP_MS,
	type WakeReason,
} from '../pi/host.ts';
import {
	enforceTimeouts,
	retireSettledReceipts,
	settledLive,
} from '../pi/receipts.ts';
import {
	expireQuestions,
	onlyParked,
	parkedQuestionTasks,
} from '../pi/questions.ts';

export interface SemanticEventEntry {
	readonly id: string;
	readonly stream: string;
	readonly event: unknown;
}

export interface SemanticEmitter {
	emitSemantic(
		entry: SemanticEventEntry,
		options?: {
			readonly immediate?: boolean;
			readonly signal?: AbortSignal;
		},
	): Promise<void>;
}

export interface FlueReactorOptions {
	readonly entityRef: EntityRef;
	readonly store: () => Promise<FlueReactorStore> | FlueReactorStore;
	readonly host: () => Promise<FluePiHost> | FluePiHost;
	readonly entity?: () => Promise<EntityRuntime | undefined> | EntityRuntime | undefined;
	readonly log?: DurableStreamLog;
	readonly armWake: (atMs: number) => Promise<void> | void;
	readonly now?: () => number;
	readonly onReport?: (error: unknown) => void;
	readonly pumpLimits?: PumpLimits;
}

export interface TickResult {
	readonly behind: boolean;
	readonly pump?: PumpResult;
	readonly nextWake?: number;
	readonly settlementsReconciled: number;
	readonly outboxDelivered: number;
}

export class FlueReactor implements SemanticEmitter {
	readonly #options: FlueReactorOptions;
	readonly #now: () => number;
	readonly #report: (error: unknown) => void;

	constructor(options: FlueReactorOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#report = options.onReport ?? (() => {});
	}

	get now(): () => number {
		return this.#now;
	}

	async resolveStore(): Promise<FlueReactorStore> {
		return typeof this.#options.store === 'function' ? this.#options.store() : this.#options.store;
	}

	async resolveHost(): Promise<FluePiHost> {
		return typeof this.#options.host === 'function' ? this.#options.host() : this.#options.host;
	}

	async resolveEntity(): Promise<EntityRuntime | undefined> {
		return typeof this.#options.entity === 'function'
			? this.#options.entity()
			: this.#options.entity;
	}

	/**
	 * Emit an externally visible semantic event through the durable outbox.
	 *
	 * Contract:
	 * 1. INSERT OR IGNORE flue_outbox (durable local obligation)
	 * 2. If immediate !== false: attempt appendCreating to Electric
	 *    - On success: DELETE flue_outbox
	 *    - On failure: set retry_at, arm alarm, and rethrow if immediate === true
	 */
	async emitSemantic(
		entry: SemanticEventEntry,
		options?: { readonly immediate?: boolean; readonly signal?: AbortSignal },
	): Promise<void> {
		const store = await this.resolveStore();
		store.enqueue(entry);

		if (options?.immediate !== false && this.#options.log) {
			try {
				await appendCreating(this.#options.log, entry.stream, entry.event, options?.signal);
				store.delivered(entry.id);
			} catch (error) {
				this.#report(error);
				const retryAt = this.#now() + 5000;
				store.failed(entry.id, retryAt);
				await Promise.resolve(this.#options.armWake(retryAt)).catch((err) => this.#report(err));
				if (options?.immediate === true) {
					throw error;
				}
			}
		}
	}

	/**
	 * Reconcile Pi settlements into durable semantic outbox events.
	 *
	 * Contract:
	 * For every settled receipt in index.live:
	 * 1. INSERT OR IGNORE flue_outbox (local SQLite obligation FIRST)
	 * 2. retire receipt from index.live (Pi live-index retirement SECOND)
	 */
	async reconcileSettlements(
		host?: FluePiHost,
		context: Context = BACKGROUND_CONTEXT,
	): Promise<number> {
		const targetHost = host ?? (await this.resolveHost());
		const store = await this.resolveStore();
		const settledIds = await settledLive(targetHost.harness, context);
		if (settledIds.length === 0) return 0;

		let count = 0;
		for (const submissionId of settledIds) {
			const settlement = await targetHost.settlement(submissionId, context);
			if (!settlement) continue;

			const domainEvent = projectSettlementToElectricEvent(settlement);
			const path = eventsPath(this.#options.entityRef);

			// Step 1: Durable SQLite obligation FIRST
			store.enqueue({
				id: domainEvent.id,
				stream: path,
				event: domainEvent,
			});

			// Step 2: Pi live-index retirement SECOND
			await retireSettledReceipts(targetHost.harness, [submissionId], context);
			count++;
		}
		return count;
	}

	/**
	 * Flush pending outbox events to Electric.
	 *
	 * Contract:
	 * For each pending entry (retry_at <= now):
	 * - append to Electric
	 * - on success: DELETE from flue_outbox
	 * - on failure: set retry_at = now + 5000, arm alarm
	 */
	async flushOutbox(context: Context = BACKGROUND_CONTEXT): Promise<number> {
		if (!this.#options.log) return 0;
		const store = await this.resolveStore();
		const now = this.#now();
		const pending = store.pendingEvents(now, 50);
		let delivered = 0;

		for (const entry of pending) {
			try {
				const event = JSON.parse(entry.eventJson);
				await appendCreating(this.#options.log, entry.stream, event, context.abortSignal);
				store.delivered(entry.eventId);
				delivered++;
			} catch (error) {
				this.#report(error);
				const retryAt = now + 5000;
				store.failed(entry.eventId, retryAt);
				await Promise.resolve(this.#options.armWake(retryAt)).catch((err) => this.#report(err));
			}
		}
		return delivered;
	}

	/**
	 * Calculate the earliest deadline across all coordination subsystems:
	 * min(inboundBehind ? now, outboxRetry, timeouts, questions, liveBackstop, schedules)
	 */
	async calculateNextWake(context: Context = BACKGROUND_CONTEXT): Promise<number | undefined> {
		const store = await this.resolveStore();
		const host = await this.resolveHost();
		const entity = await this.resolveEntity();
		const now = this.#now();
		const candidates: number[] = [];

		// 1. Inbound streams still behind
		if (store.behind()) {
			candidates.push(now);
		}

		// 2. Outbox retry_at
		const outboxRetry = store.earliestRetry();
		if (outboxRetry !== undefined) {
			candidates.push(outboxRetry);
		}

		// 3. Pi deadlines & timeouts
		const timeoutDeadline = await enforceTimeouts(host.harness, now, context);
		if (timeoutDeadline !== undefined) {
			candidates.push(timeoutDeadline);
		}

		const questionDeadline = await expireQuestions(host.harness, now, context);
		if (questionDeadline !== undefined) {
			candidates.push(questionDeadline);
		}

		const inspection = await host.harness.inspect(context);
		const hasLiveWork =
			inspection.tasks.length > 0 &&
			!onlyParked(inspection.tasks, await parkedQuestionTasks(host.harness, context));
		if (hasLiveWork) {
			candidates.push(now + LIVE_TASK_BACKSTOP_MS);
		}

		// 4. Schedules
		if (entity?.schedules) {
			const nextSchedule = await entity.schedules.next(context);
			if (nextSchedule !== undefined) {
				candidates.push(nextSchedule);
			}
		}

		if (candidates.length === 0) return undefined;
		return Math.min(...candidates);
	}

	/**
	 * One reactor tick: the single reconciliation entry point.
	 *
	 * 1. Drain inbound Electric streams
	 * 2. Let Pi repair / resume
	 * 3. Reconcile Pi settlements → semantic outbox
	 * 4. Flush semantic outbox
	 * 5. Fire due schedules / questions (executed during Pi wake)
	 * 6. Calculate next wake and set single alarm
	 */
	async tick(options?: {
		readonly reason?: WakeReason;
		readonly context?: Context;
	}): Promise<TickResult> {
		const context = options?.context ?? BACKGROUND_CONTEXT;
		const store = await this.resolveStore();
		const host = await this.resolveHost();
		const entity = await this.resolveEntity();

		// Step 1: Drain inbound Electric streams
		let pump: PumpResult | undefined;
		if (entity && this.#options.log && store.behind()) {
			pump = await pumpEntity(entity, store, context, {
				...(this.#options.pumpLimits ? { limits: this.#options.pumpLimits } : {}),
				now: this.#now,
			});
		}

		// Step 2: Let Pi repair / resume
		if (entity) {
			await entity.schedules.fireDue(context);
		}
		await host.wake(options?.reason ?? { kind: 'live-tasks' }, context);

		// Step 3: Reconcile Pi settlements → semantic outbox
		const settlementsReconciled = await this.reconcileSettlements(host, context);

		// Step 4: Flush semantic outbox
		const outboxDelivered = await this.flushOutbox(context);

		// Step 5: Fire due schedules/questions executed during Step 2

		// Step 6: Calculate next wake and arm alarm
		const nextWake = await this.calculateNextWake(context);
		if (nextWake !== undefined && Number.isFinite(nextWake)) {
			await Promise.resolve(this.#options.armWake(nextWake)).catch((err) => this.#report(err));
		}

		return {
			behind: pump?.behind ?? store.behind(),
			...(pump ? { pump } : {}),
			nextWake,
			settlementsReconciled,
			outboxDelivered,
		};
	}
}
