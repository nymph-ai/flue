/**
 * The question seam: the one place the MCP client and Code Mode ask for an
 * answer only a participant can give (docs/cloudflare-native.md rule 9).
 *
 * Two things ask:
 *
 * - Code Mode, when a script calls a tool that `requiresApproval`. The
 *   script waits on that call; the nested calls it made before are
 *   journaled (`codemode/journal.ts`), so a rerun after an eviction reaches
 *   the same call without repeating them.
 * - The MCP client, when a server answers a request with `input_required`
 *   carrying input requests (an elicitation, a sampling request, the roots
 *   list) and, usually, an opaque `requestState`.
 *
 * Both call {@link askQuestion}. An agent instance with entity streams
 * answers through its own handler (see "The Electric handler" below);
 * elsewhere the process-wide one set with {@link setQuestionHandler} does,
 * and by default it rejects every question with
 * {@link QuestionsNotWiredError}, so the asking call fails with that message.
 *
 * ## The handler contract
 *
 * `handler(question, signal)` returns a promise that settles in one of three
 * ways. The caller acts on each as follows.
 *
 * 1. **Resolves with a {@link FlueAnswer}** of the question's `kind`. The
 *    caller continues the call in place:
 *    - `codemode-approval`, `decision: 'approve'`: the waiting call runs and
 *      the script continues. A later call that needs approval asks again with
 *      a new question.
 *    - `codemode-approval`, `decision: 'reject'`: the waiting call rejects
 *      inside the script with an Error saying so, with `reason` when given;
 *      the script may catch it. Calls made earlier are not undone.
 *    - `mcp-input`: the original request is sent again on a fresh request id
 *      with `params.inputResponses` set to the answer's `inputResponses` and
 *      `params.requestState` set to the question's `requestState`, echoed
 *      byte for byte. If the server answers `input_required` again, the
 *      caller asks again (a new question, a new id), up to 10 rounds.
 *
 * 2. **Rejects with {@link QuestionParkedError}** for this question. The
 *    handler has durably parked it — recorded it, published it, and holds
 *    everything needed to continue (`id`, and for MCP the `requestState` and
 *    original `params`; for Code Mode the journal holds the script and its
 *    calls' results). The caller ends the call now without failing it:
 *    - Code Mode ends the script and returns a non-error tool result saying
 *      it is paused, naming the question id. The handler's lane continues it
 *      later with {@link import('./codemode/tool.ts').resumeCodemodeQuestion},
 *      which runs the script again over its journal with the same
 *      {@link FlueAnswer} and returns the tool result of the continued run.
 *    - The MCP client fails the request with the parked error (its message
 *      names the question id); the handler's lane retries the `tools/call`
 *      itself, as in (1), once the answer arrives.
 *
 * 3. **Rejects with anything else.** The question cannot be answered. The
 *    caller fails the call with that error's message: in Code Mode the
 *    waiting call rejects inside the script; the MCP client fails the request
 *    with {@link import('./mcp.ts').McpInputRequiredError}.
 *
 * A handler must be idempotent on `question.id`: the id is derived from the
 * question's content (Code Mode: the execution, the tool and its arguments;
 * MCP: server, method, original params and `requestState`), so a call that
 * is retried after an eviction asks with the same id. Asking again for a
 * parked id must not publish it twice; asking for an id whose answer has
 * already arrived resolves with that answer at once.
 *
 * `signal` aborts when the asking call is aborted (the turn was cancelled).
 * A handler that is still waiting should then reject — parking (2) is the
 * normal response.
 *
 * ## The Electric handler
 *
 * With entity streams configured, every agent instance installs
 * `entity/questions.ts`'s handler as {@link QUESTION_HANDLER} (rule 9). It
 * answers through case 1 and parks *inside* Pi Durable: the question becomes
 * a `flue.question` task owned by the asking tool call, the call waits on it,
 * and the turn stays open without a model round trip. If the instance is
 * evicted meanwhile, the wait rejects with {@link QuestionParkedError}
 * (case 2) and Pi reruns the tool call on the next wake; the rerun finds the
 * parked question and continues it (`pi/questions.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextKey } from '@earendil-works/chord';
import { createContextKey } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';

/** One action a Code Mode execution is paused on. */
export interface CodemodePendingAction {
	/** Position of the call among the script's nested calls. */
	readonly seq: number;
	/** The sandbox namespace: `tools`. */
	readonly connector: string;
	/** The tool, as the script names it (`tools.<method>`). */
	readonly method: string;
	/** The arguments the script passed. */
	readonly args: unknown;
}

/** Code Mode wants approval for the pending actions of one execution. */
export interface CodemodeApprovalQuestion {
	readonly kind: 'codemode-approval';
	/** `codemode:<executionId>:<hash of the call>` — stable across retries. */
	readonly id: string;
	/** The waiting execution: `<conversation>:<call id>` of its `codemode` call. */
	readonly executionId: string;
	/** The actions awaiting a decision (usually one). */
	readonly pending: readonly CodemodePendingAction[];
	/** The Pi conversation and tool call that ran the script. */
	readonly conversationId: string;
	readonly callId: string;
}

/** An MCP server answered a request with `input_required`. */
export interface McpInputQuestion {
	readonly kind: 'mcp-input';
	/** `mcp:<server>:<hash>` — stable across retries of the same leg. */
	readonly id: string;
	/** Declared server name. */
	readonly server: string;
	/** The request that came back `input_required`, e.g. `tools/call`. */
	readonly method: string;
	/** Its params as originally sent, without `inputResponses`/`requestState`. */
	readonly params: Readonly<Record<string, unknown>>;
	/** The server's input requests, keyed as it keyed them. */
	readonly inputRequests: Readonly<Record<string, unknown>>;
	/** Opaque server state to echo back unchanged with the answers. */
	readonly requestState?: string;
}

export type FlueQuestion = CodemodeApprovalQuestion | McpInputQuestion;

/** The answer to a {@link FlueQuestion}, of the same `kind`. */
export type FlueAnswer =
	| {
			readonly kind: 'codemode-approval';
			readonly decision: 'approve';
	  }
	| {
			readonly kind: 'codemode-approval';
			readonly decision: 'reject';
			/** Shown to the model. */
			readonly reason?: string;
	  }
	| {
			readonly kind: 'mcp-input';
			/** One entry per input request key the server sent. */
			readonly inputResponses: Readonly<Record<string, unknown>>;
	  };

/**
 * The tool call a question is asked from: the Pi tool invocation and its
 * context. The Electric lane's handler parks the question inside it
 * (`entity/questions.ts`); the module-level default handler ignores it.
 */
export interface QuestionCall {
	readonly api: ToolExecutionApi;
	readonly context: Context;
}

/** Answers questions; see the module documentation for the contract. */
export type QuestionHandler = (
	question: FlueQuestion,
	signal?: AbortSignal,
	call?: QuestionCall,
) => Promise<FlueAnswer>;

/** The question was durably parked; the call ends now and is continued when the answer arrives. */
export class QuestionParkedError extends Error {
	override readonly name = 'QuestionParkedError';
	constructor(readonly question: FlueQuestion) {
		super(`[flue] Waiting for an answer to ${question.id}; the call continues when it arrives.`);
	}
}

/** The question was not answered before `useQuestions({ timeoutMs })` ran out. */
export class QuestionTimeoutError extends Error {
	override readonly name = 'QuestionTimeoutError';
	constructor(readonly questionId: string) {
		super(`[flue] Nobody answered ${questionId} in time; the question expired.`);
	}
}

/** The question was withdrawn (its call was aborted or interrupted) before an answer arrived. */
export class QuestionCancelledError extends Error {
	override readonly name = 'QuestionCancelledError';
	constructor(readonly questionId: string) {
		super(`[flue] ${questionId} was withdrawn before it was answered.`);
	}
}

/** The default handler's error: nothing in this build answers questions yet. */
export class QuestionsNotWiredError extends Error {
	override readonly name = 'QuestionsNotWiredError';
	constructor(readonly question: FlueQuestion) {
		super(
			`[flue] ${describeQuestion(question)} needs an answer from a person, but questions are not wired in this build: ` +
				'approvals and MCP input requests are not yet published as entity events.',
		);
	}
}

function describeQuestion(question: FlueQuestion): string {
	if (question.kind === 'codemode-approval') {
		const actions = question.pending.map((action) => `${action.connector}.${action.method}`);
		return `Code Mode approval of ${actions.join(', ') || 'a pending action'}`;
	}
	return `MCP server "${question.server}"'s input request on ${question.method}`;
}

const notWired: QuestionHandler = (question) =>
	Promise.reject(new QuestionsNotWiredError(question));

let handler: QuestionHandler = notWired;

/**
 * Install the process-wide question handler (`undefined` restores the
 * not-wired default). An agent instance with entity streams installs its own
 * per instance instead, as the {@link QUESTION_HANDLER} value of its Pi
 * context; that one wins inside the instance's tool calls.
 */
export function setQuestionHandler(next: QuestionHandler | undefined): void {
	handler = next ?? notWired;
}

/**
 * The per-instance question handler, carried by the Pi Harness context, so
 * every task invocation (and so every tool call) of the instance sees it.
 */
export const QUESTION_HANDLER: ContextKey<QuestionHandler> =
	createContextKey<QuestionHandler>('flue.questions.handler');

const callScope = new AsyncLocalStorage<QuestionCall>();

/**
 * Run `work` as part of `call`: a question asked anywhere below it — deep in
 * the MCP client, or from a Code Mode connector — is asked from this tool
 * call. Tools that can ask (the `codemode` tool and MCP tools) wrap their
 * execution in it.
 */
export function runInQuestionCall<T>(call: QuestionCall, work: () => T): T {
	return callScope.run(call, work);
}

/** The tool call a question asked now would belong to, if any. */
export function currentQuestionCall(): QuestionCall | undefined {
	return callScope.getStore();
}

/**
 * Ask: the instance's handler when the current tool call carries one, else
 * the process-wide one. Resolves only with an answer of the question's kind;
 * a mismatched answer is a handler bug and rejects.
 */
export async function askQuestion(
	question: FlueQuestion,
	signal?: AbortSignal,
): Promise<FlueAnswer> {
	const call = callScope.getStore();
	const scoped = call?.context.value(QUESTION_HANDLER);
	const answer = scoped
		? await scoped(question, signal, call)
		: await handler(question, signal, call);
	if (!answer || answer.kind !== question.kind) {
		throw new Error(
			`[flue] The question handler answered ${question.id} with a "${String(answer?.kind)}" answer; expected "${question.kind}".`,
		);
	}
	return answer;
}
