/**
 * Self-schedules (PI_UPGRADE_PLAN.md §2.5 "schedule"): a `flue.schedules`
 * doc per key plus the `flue.schedule-index` of armed ones, both canonical Pi
 * state, and the Reactor calculation of the next wake at the earliest due time. A due schedule is admitted with
 * `submissionId = requestId = "sched:{key}"`, so firing twice — a crash
 * between admission and the `fired` mark, two overlapping wakes — admits once.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import type { FluePiHost } from '../pi/host.ts';
import { FlueSchedules } from '../pi/docs.ts';
import type { DeliveredMessage } from '../types.ts';
import { deliveredMessageJson, FlueScheduleIndex } from './docs.ts';

export interface ScheduleBookOptions {
	readonly host: FluePiHost;
	readonly now: () => number;
	readonly onReport: (error: unknown) => void;
}

/** The submission id (and Pi request id) a schedule fires with. */
export function scheduleSubmissionId(key: string): string {
	return `sched:${key}`;
}

export class ScheduleBook {
	readonly #options: ScheduleBookOptions;

	constructor(options: ScheduleBookOptions) {
		this.#options = options;
	}

	/**
	 * Arm `key` to deliver `message` at `atMs`; re-arming an armed or
	 * cancelled key moves it. A fired key stays fired: a schedule id fires once.
	 * Returns whether the key is armed afterwards.
	 */
	async arm(
		key: string,
		atMs: number,
		message: DeliveredMessage,
		context: Context,
	): Promise<boolean> {
		if (!Number.isFinite(atMs))
			throw new TypeError(`[flue] Schedule "${key}" needs a finite time.`);
		const armed = await this.#options.host.harness.commit(async (tx) => {
			const schedule = await tx.doc(FlueSchedules, key, null);
			if (schedule.status === 'fired') return false;
			schedule.atMs = atMs;
			schedule.message = deliveredMessageJson(message);
			schedule.status = 'armed';
			const index = await tx.doc(FlueScheduleIndex);
			index.armed[key] = atMs;
			return true;
		}, context);
		return armed;
	}

	/** Cancel an armed key; `false` when it was not armed. */
	async cancel(key: string, context: Context): Promise<boolean> {
		return this.#options.host.harness.commit(async (tx) => {
			const schedule = await tx.doc(FlueSchedules, key, null);
			const index = await tx.doc(FlueScheduleIndex);
			if (schedule.status !== 'armed') return false;
			schedule.status = 'cancelled';
			delete index.armed[key];
			return true;
		}, context);
	}

	/** The earliest armed due time, if any. */
	async next(context: Context): Promise<number | undefined> {
		const index = await this.#options.host.harness.snapshot(FlueScheduleIndex, context);
		const times = Object.values(index?.armed ?? {});
		return times.length === 0 ? undefined : Math.min(...times);
	}

	/**
	 * Admit every armed schedule due by now, mark it fired, and re-arm the wake
	 * for the next one. Returns the fired keys.
	 */
	async fireDue(context: Context): Promise<string[]> {
		const { host, now } = this.#options;
		const index = await host.harness.snapshot(FlueScheduleIndex, context);
		const due = Object.entries(index?.armed ?? {})
			.filter(([, atMs]) => atMs <= now())
			.sort((left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : 1));
		const fired: string[] = [];
		for (const [key] of due) {
			const schedule = await host.harness.snapshot(FlueSchedules, key, context);
			if (schedule?.status === 'armed') {
				try {
					await host.admit(
						{
							submissionId: scheduleSubmissionId(key),
							kind: 'dispatch',
							message: schedule.message as unknown as DeliveredMessage,
							acceptedAt: new Date(now()).toISOString(),
							whenBusy: 'followUp',
						},
						context,
					);
				} catch (error) {
					// A schedule that cannot be admitted (e.g. a conflicting id) must not wedge the others.
					this.#options.onReport(error);
				}
			}
			await host.harness.commit(async (tx) => {
				const draft = await tx.doc(FlueSchedules, key, null);
				if (draft.status === 'armed') draft.status = 'fired';
				const draftIndex = await tx.doc(FlueScheduleIndex);
				delete draftIndex.armed[key];
			}, context);
			fired.push(key);
		}
		return fired;
	}

	/** The stored schedule of a key, if any. */
	async read(
		key: string,
		context: Context,
	): Promise<
		{ readonly atMs: number; readonly message: JsonValue; readonly status: string } | undefined
	> {
		return this.#options.host.harness.snapshot(FlueSchedules, key, context);
	}
}
