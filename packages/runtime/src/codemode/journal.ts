/**
 * What a parked script's nested calls returned, so it can run again after an
 * eviction without repeating them.
 *
 * A script's VM lives only in the isolate's memory. When a nested call has to
 * wait for a person — an approval, or an MCP server's `input_required` — the
 * question parks inside Pi (`pi/questions.ts`) and the turn stays open; if
 * the Durable Object is evicted meanwhile, Pi reruns the `codemode` call on
 * the next wake and the script starts from the top. The rerun answers every
 * nested call it already made from this journal, in the order the script
 * makes them, and reaches the parked call again, which then takes the answer.
 *
 * Only a script that parks pays for it: until its first question every
 * result is kept in memory, and asking writes them all in one commit; after
 * that each result is written as it arrives. A script that never asks
 * writes nothing here.
 *
 * A call is identified by its tool, its arguments and how many identical
 * calls came before it (`key`), not by its position: scripts that run calls
 * concurrently (`Promise.all`) may issue them in another order on the rerun,
 * when the journal answers at once.
 */
import type { Context, JsonValue } from '@earendil-works/chord';
import { defineDocFamily, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { boundedDeltas } from '../pi/docs.ts';

/** One nested call's outcome: its value, or the error message it rejected with. */
export type JournalOutcome =
	| { readonly ok: true; readonly value: JsonValue | null }
	| {
			readonly ok: false;
			readonly error: string;
	  };

export type FlueCodemodeJournalState = {
	/** The script, for a continuation that does not have the call's arguments. */
	code: string | null;
	/** `[key, ok, value or error]`, in the order the calls settled. */
	entries: [string, boolean, JsonValue][];
	/** `[key, question id]` of each call that asked from inside its tool (an MCP `input_required`). */
	asked: [string, string][];
};

/** Keyed by the execution id (`<conversation>:<call id>`). */
export const FlueCodemodeJournal = defineDocFamily<FlueCodemodeJournalState, null>({
	kind: 'flue.codemode.journal',
	version: 1,
	checkpointWhen: boundedDeltas,
	family: true,
	scope: 'session',
	initial: () => ({ code: null, entries: [], asked: [] }),
});

/** What identical calls share: the tool and its arguments. */
export function callBase(tool: string, args: unknown): string {
	return `${tool}\u0000${JSON.stringify(args) ?? 'undefined'}`;
}

/** The identity of a nested call: its {@link callBase} and its occurrence among identical calls. */
export function callKey(base: string, occurrence: number): string {
	return `${base}\u0000${occurrence}`;
}

export class CallJournal {
	readonly #id: string;
	readonly #api: ToolExecutionApi;
	readonly #context: Context;
	readonly #code: string;
	/** Outcomes recorded by an earlier run, not yet replayed. */
	readonly #replay: Map<string, JournalOutcome>;
	/** Questions asked from inside a call by an earlier run, by call key. */
	readonly #asked: Map<string, string>;
	/** Outcomes of this run not yet written. */
	#unwritten: [string, boolean, JsonValue][] = [];
	#unwrittenAsked: [string, string][] = [];
	#persistent: boolean;
	/** Whether the stored journal already carries this script. */
	#written: boolean;
	#writes: Promise<void> = Promise.resolve();

	private constructor(
		id: string,
		api: ToolExecutionApi,
		context: Context,
		code: string,
		recorded: FlueCodemodeJournalState | undefined,
	) {
		this.#id = id;
		this.#api = api;
		this.#context = context;
		this.#code = code;
		this.#persistent = recorded !== undefined && recorded.code !== null;
		this.#written = this.#persistent;
		this.#replay = new Map(
			(recorded?.entries ?? []).map(([key, ok, value]) => [
				key,
				ok ? { ok: true, value } : { ok: false, error: String(value) },
			]),
		);
		this.#asked = new Map(recorded?.asked ?? []);
	}

	/** A first run's journal: in memory only, until the script asks. */
	static fresh(id: string, api: ToolExecutionApi, context: Context, code: string): CallJournal {
		return new CallJournal(id, api, context, code, undefined);
	}

	/** The journal a parked run left, read for its continuation (`undefined`: none was written). */
	static async recorded(
		id: string,
		api: ToolExecutionApi,
		context: Context,
	): Promise<{ journal: CallJournal; code: string } | undefined> {
		const state = await api.snapshot(FlueCodemodeJournal, id, context);
		if (!state || state.code === null) return undefined;
		return { journal: new CallJournal(id, api, context, state.code, state), code: state.code };
	}

	/** An earlier run's outcome of this call, taken once. */
	take(key: string): JournalOutcome | undefined {
		const found = this.#replay.get(key);
		if (found) this.#replay.delete(key);
		return found;
	}

	/** The question an earlier run's call `key` asked from inside its tool, if it did. */
	askedBy(key: string): string | undefined {
		return this.#asked.get(key);
	}

	/** Record a call's outcome; written at once if the script has asked before. */
	record(key: string, outcome: JournalOutcome): Promise<void> {
		this.#unwritten.push([key, outcome.ok, outcome.ok ? outcome.value : outcome.error]);
		return this.#persistent ? this.#flush() : Promise.resolve();
	}

	/**
	 * Before asking: write everything so far, and every outcome from now on.
	 * `asking` names the call that asks from inside its tool, and its question.
	 */
	persist(asking?: { readonly key: string; readonly questionId: string }): Promise<void> {
		this.#persistent = true;
		if (asking && this.#asked.get(asking.key) !== asking.questionId) {
			this.#asked.set(asking.key, asking.questionId);
			this.#unwrittenAsked.push([asking.key, asking.questionId]);
		}
		return this.#flush();
	}

	/** The script settled: nothing is left to continue. */
	async close(): Promise<void> {
		if (!this.#persistent) return;
		await this.#writes;
		await this.#api.commit(async (tx) => {
			const draft = await tx.doc(FlueCodemodeJournal, this.#id, null);
			draft.code = null;
			draft.entries = [];
			draft.asked = [];
		}, this.#context);
	}

	#flush(): Promise<void> {
		this.#writes = this.#writes.then(async () => {
			const batch = this.#unwritten;
			const asked = this.#unwrittenAsked;
			this.#unwritten = [];
			this.#unwrittenAsked = [];
			// A rerun asking again with nothing new writes nothing.
			if (this.#written && batch.length === 0 && asked.length === 0) return;
			this.#written = true;
			await this.#api.commit(async (tx) => {
				const draft = await tx.doc(FlueCodemodeJournal, this.#id, null);
				draft.code = this.#code;
				draft.entries.push(...batch);
				draft.asked.push(...asked);
			}, this.#context);
		});
		return this.#writes;
	}
}
