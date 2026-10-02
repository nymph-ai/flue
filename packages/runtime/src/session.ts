/**
 * `FlueSession` over one Pi Durable conversation (PI_UPGRADE_PLAN.md §1
 * `session.ts` row, §7 step 14): the facade that keeps Flue's session
 * signatures — `prompt` / `skill` / `task` / `shell` / `compact` / `fs` and
 * their `CallHandle`s — while Pi owns the loop, compaction, retries,
 * recovery and the inbox.
 *
 * A call is one Pi input submission into the session's conversation, awaited
 * to its settlement; its answer is read back from the conversation's
 * entries. Per-call options are applied around the submission: `model` and
 * `thinkingLevel` as conversation configuration, `tools` as call-scoped
 * registrations activated for this conversation, and `result` as the
 * terminating `finish` / `give_up` pair whose accepted value the answer's
 * tool round recorded.
 */
import type { Context } from '@earendil-works/chord';
import { withAbortSignal } from '@earendil-works/chord/context';
import type { AssistantMessage, ImageContent, UserMessage } from '@earendil-works/pi-ai';
import {
	ConversationBusy,
	type AgentChange,
	type Conversation,
	type ConversationId,
	type EntryId,
	type EntryRecord,
	type ToolRegistration,
} from '@earendil-works/pi-durable';
import type * as v from 'valibot';
import { abortErrorFor, createCallHandle } from './abort.ts';
import { isWorkspaceSkill } from './context.ts';
import { mergeOperationAttachments } from './document-attachments.ts';
import { SessionBusyError, SkillNotRegisteredError } from './errors.ts';
import type { FlueExecutionContext } from './execution-interceptor.ts';
import { GeneralSubagent } from './hooks/use-subagent.ts';
import { parseModelSpecifier } from './pi/config.ts';
import type { FluePiHost, Registration } from './pi/host.ts';
import { packagedDirectoryOf } from './pi/skills.ts';
import { resultFromToolDetails, resultToolRegistrations } from './pi/tools.ts';
import {
	buildPackagedSkillPrompt,
	buildPromptText,
	buildResultFollowUpPrompt,
	buildSkillByPathlessNamePrompt,
	buildWorkspaceSkillPrompt,
	FINISH_TOOL_NAME,
	GIVE_UP_TOOL_NAME,
	ResultUnavailableError,
} from './result.ts';
import { execShellWithEvents } from './shell.ts';
import type {
	CallHandle,
	FlueEventInput,
	FlueFs,
	FlueObservationDetail,
	FlueSession,
	PromptImage,
	PromptOptions,
	PromptResponse,
	PromptUsage,
	RegisteredSkill,
	Sandbox,
	ShellOptions,
	ShellResult,
	Skill,
	SkillOptions,
	TaskOptions,
	ThinkingLevel,
	ToolDefinition,
} from './types.ts';
import { addUsage, emptyUsage, fromProviderUsage } from './usage.ts';

/** How many times a result prompt is re-asked when the model answers without `finish`. */
const RESULT_FOLLOW_UPS = 2;

export interface PiSessionOptions {
	readonly host: FluePiHost;
	readonly conversationId: ConversationId;
	readonly name: string;
	/** The live sandbox; throws when the agent declared none. */
	readonly sandbox: () => Sandbox;
	readonly emit: (event: FlueEventInput, observation?: FlueObservationDetail) => void;
	readonly executionContext: (fields?: Partial<FlueExecutionContext>) => FlueExecutionContext;
	/** Context the session's calls derive theirs from (a tool call's, or the background). */
	readonly context: Context;
}

/** Result prompts share the registry's `finish` / `give_up` names: one at a time per host. */
const resultLocks = new WeakMap<FluePiHost, Promise<unknown>>();

async function withResultLock<T>(host: FluePiHost, run: () => Promise<T>): Promise<T> {
	const previous = resultLocks.get(host) ?? Promise.resolve();
	const current = previous.then(run, run);
	resultLocks.set(
		host,
		current.then(
			() => {},
			() => {},
		),
	);
	return current;
}

interface CallInput {
	readonly text: string;
	readonly images?: readonly PromptImage[];
	readonly result?: v.GenericSchema;
	readonly tools?: readonly ToolDefinition[];
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
}

function answerText(message: AssistantMessage | undefined): string {
	return (message?.content ?? [])
		.flatMap((part) => (part.type === 'text' ? [part.text] : []))
		.join('');
}

function userContent(
	text: string,
	images: readonly PromptImage[] | undefined,
): UserMessage['content'] {
	if (!images?.length) return text;
	return [
		{ type: 'text', text },
		...images.map((image): ImageContent => ({ ...image, type: 'image' })),
	];
}

/** Every entry of one run: from its input entry through its answer, oldest first. */
async function runEntries(
	conversation: Conversation,
	from: EntryId,
	context: Context,
): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Parameters<Conversation['entries']>[2];
	do {
		const page = await conversation.entries({ minEntryId: from }, 500, cursor, context);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return entries.reverse();
}

class PiSession implements FlueSession {
	readonly name: string;
	readonly conversationId: string;
	readonly fs: FlueFs;
	readonly #options: PiSessionOptions;

	constructor(options: PiSessionOptions) {
		this.#options = options;
		this.name = options.name;
		this.conversationId = `pi:${options.conversationId}`;
		const sandbox = options.sandbox;
		this.fs = {
			readFile: (path) => sandbox().readFile(path),
			readFileBuffer: (path) => sandbox().readFileBuffer(path),
			writeFile: (path, content) => sandbox().writeFile(path, content),
			stat: (path) => sandbox().stat(path),
			readdir: (path) => sandbox().readdir(path),
			exists: (path) => sandbox().exists(path),
			mkdir: (path, mkdirOptions) => sandbox().mkdir(path, mkdirOptions),
			rm: (path, rmOptions) => sandbox().rm(path, rmOptions),
		};
	}

	prompt(text: string, options?: PromptOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, (signal) =>
			this.#call(
				{
					text,
					...(options?.result ? { result: options.result } : {}),
					...(options?.tools ? { tools: options.tools } : {}),
					...(options?.model ? { model: options.model } : {}),
					...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
					images: mergeOperationAttachments(options?.images, options?.documents),
				},
				signal,
			),
		);
	}

	skill(
		skill: Skill | string,
		options?: SkillOptions<v.GenericSchema | undefined>,
	): CallHandle<any> {
		return createCallHandle(options?.signal, async (signal) => {
			const text = await this.#skillPrompt(skill, options?.args, options?.result);
			return this.#call(
				{
					text,
					...(options?.result ? { result: options.result } : {}),
					...(options?.tools ? { tools: options.tools } : {}),
					...(options?.model ? { model: options.model } : {}),
					...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
					images: mergeOperationAttachments(options?.images, options?.documents),
				},
				signal,
				{ footer: false },
			);
		});
	}

	task(text: string, options?: TaskOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, async (signal) => {
			if (options?.result) {
				throw new Error(
					'[flue] session.task({ result }) is not supported: a delegate answers with text. Ask it for JSON and parse the answer, or prompt with `result` instead.',
				);
			}
			const { host } = this.#options;
			const context = withAbortSignal(signal, this.#options.context);
			const result = await host.taskIn(
				this.#options.conversationId,
				{ agent: options?.agent ?? GeneralSubagent, prompt: text },
				context,
			);
			return {
				text: result.text,
				usage: emptyUsage(),
				model: this.#modelOf(await this.#conversation(context), context),
			} satisfies PromptResponse;
		});
	}

	shell(command: string, options?: ShellOptions): CallHandle<ShellResult> {
		return createCallHandle(options?.signal, async (signal) => {
			return execShellWithEvents(
				this.#options.sandbox(),
				this.#options.emit,
				command,
				options,
				signal,
				this.#options.executionContext(),
				async (_toolCallId, _args, result, isError) => {
					const context = withAbortSignal(signal, this.#options.context);
					const conversation = await this.#conversation(context);
					const output = result.content
						.flatMap((part) => (part.type === 'text' ? [part.text] : []))
						.join('');
					await conversation.submit(
						{
							type: 'write',
							entry: {
								kind: 'flue.shell',
								data: { command, isError, output },
								model: [
									{
										role: 'user',
										content: `<shell command=${JSON.stringify(command)}${isError ? ' error="true"' : ''}>\n${output}\n</shell>`,
										timestamp: Date.now(),
									},
								],
							},
						},
						context,
					);
				},
			);
		});
	}

	async compact(): Promise<void> {
		const { host } = this.#options;
		const context = this.#options.context;
		const conversation = await this.#conversation(context);
		const taskId = await conversation.compact(undefined, context);
		const settled = await host.harness.waitForTask(taskId, context);
		const outcome = settled.state.outcome;
		if (outcome.status === 'failed' || outcome.status === 'faulted')
			throw new Error(outcome.error.message);
	}

	async #conversation(context: Context): Promise<Conversation> {
		const conversation = await this.#options.host.harness.conversation(
			this.#options.conversationId,
			context,
		);
		if (!conversation) {
			throw new Error(`[flue] The conversation of session "${this.name}" no longer exists.`);
		}
		return conversation;
	}

	#modelOf(_conversation: Conversation, _context: Context): PromptResponse['model'] {
		const specifier = this.#options.host.render?.model;
		if (!specifier) return { provider: '', id: '' };
		const ref = parseModelSpecifier(specifier);
		return { provider: ref.provider, id: ref.modelId };
	}

	async #skillPrompt(
		skill: Skill | string,
		args: Record<string, unknown> | undefined,
		schema: v.GenericSchema | undefined,
	): Promise<string> {
		const name = typeof skill === 'string' ? skill : skill.name;
		const skills: readonly RegisteredSkill[] = this.#options.host.render?.skills ?? [];
		const registered =
			skills.find((candidate) => candidate.name === name) ??
			(typeof skill === 'string' ? undefined : skill);
		if (!registered) {
			throw new SkillNotRegisteredError({
				skill: name,
				available: skills.map((each) => each.name),
			});
		}
		if (isWorkspaceSkill(registered)) {
			const raw = await this.#options.sandbox().readFile(registered.skillMdPath);
			return buildWorkspaceSkillPrompt(
				registered.name,
				registered.directory,
				registered.skillMdPath,
				raw,
			);
		}
		const directory = packagedDirectoryOf(registered);
		return directory
			? buildPackagedSkillPrompt(directory, args, schema)
			: buildSkillByPathlessNamePrompt(name, args, schema);
	}

	async #call(
		input: CallInput,
		signal: AbortSignal,
		options: { footer?: boolean } = {},
	): Promise<any> {
		const run = () => this.#run(input, signal, options.footer !== false);
		return input.result ? withResultLock(this.#options.host, run) : run();
	}

	async #run(input: CallInput, signal: AbortSignal, footer: boolean): Promise<any> {
		const { host } = this.#options;
		const context = withAbortSignal(signal, this.#options.context);
		const conversation = await this.#conversation(context);
		const restore: (() => Promise<void>)[] = [];
		let registration: Registration | undefined;
		try {
			const agent = await conversation.agent(context);
			const change: AgentChange = {};
			const previousChange: AgentChange = {};
			let modified = false;

			if (input.model !== undefined) {
				change.model = parseModelSpecifier(input.model);
				previousChange.model = agent.model ?? null;
				modified = true;
			}
			if (input.thinkingLevel !== undefined) {
				change.thinkingLevel = input.thinkingLevel;
				previousChange.thinkingLevel = agent.thinkingLevel ?? null;
				modified = true;
			}
			const extra = input.result ? resultToolRegistrations(input.result) : [];
			if ((input.tools?.length ?? 0) > 0 || extra.length > 0) {
				registration = host.addTools(input.tools ?? [], extra);
				const previousNames = agent.tools.map((tool) => tool.name);
				const added = [
					...(input.tools ?? []).map((tool) => tool.name),
					...extra.map((tool) => tool.name),
				];
				change.tools = [...new Set([...previousNames, ...added])].map(
					(name) => ({ name }) as unknown as ToolRegistration,
				);
				previousChange.tools = previousNames.map(
					(name) => ({ name }) as unknown as ToolRegistration,
				);
				modified = true;
			}
			if (modified) {
				await conversation.configure(change, context);
				restore.push(() => conversation.configure(previousChange, context));
			}
			const text = footer ? buildPromptText(input.text, input.result) : input.text;
			let response = await this.#submit(
				conversation,
				userContent(text, input.images),
				context,
				signal,
			);
			if (!input.result) return response.answer;
			for (let attempt = 0; ; attempt++) {
				if (response.outcome?.type === 'finished') {
					return {
						data: response.outcome.value,
						usage: response.answer.usage,
						model: response.answer.model,
					};
				}
				if (response.outcome?.type === 'gave_up') {
					throw new ResultUnavailableError(response.outcome.reason, response.answer.text);
				}
				if (attempt >= RESULT_FOLLOW_UPS) {
					throw new ResultUnavailableError(
						`the model did not call \`${FINISH_TOOL_NAME}\` or \`${GIVE_UP_TOOL_NAME}\``,
						response.answer.text,
					);
				}
				const usage = response.answer.usage;
				response = await this.#submit(conversation, buildResultFollowUpPrompt(), context, signal);
				response.answer.usage = addUsage(usage, response.answer.usage);
			}
		} finally {
			for (const undo of restore.reverse()) await undo().catch(() => {});
			registration?.dispose();
		}
	}

	async #submit(
		conversation: Conversation,
		content: UserMessage['content'],
		context: Context,
		signal: AbortSignal,
	): Promise<{
		answer: PromptResponse;
		outcome: ReturnType<typeof resultFromToolDetails>;
	}> {
		let submission: Awaited<ReturnType<Conversation['submit']>>;
		try {
			submission = await conversation.submit(
				{
					type: 'input',
					content,
					requestId: `flue.call:${crypto.randomUUID()}`,
					whenBusy: 'reject',
				},
				context,
			);
		} catch (error) {
			if (error instanceof ConversationBusy) {
				throw new SessionBusyError({ session: this.name, activeOperation: 'prompt' });
			}
			throw error;
		}
		const onAbort = () => {
			void submission
				.abort(this.#options.context)
				.then((outcome) =>
					outcome === 'already_placed' ? conversation.abort(this.#options.context) : undefined,
				)
				.catch(() => {});
		};
		signal.addEventListener('abort', onAbort, { once: true });
		let settled: Awaited<ReturnType<typeof submission.wait>>;
		try {
			settled = await submission.wait(this.#options.context);
		} finally {
			signal.removeEventListener('abort', onAbort);
		}
		if (settled.status !== 'done' || settled.type !== 'input') {
			if (signal.aborted) throw abortErrorFor(signal);
			const reason = settled.status === 'unanswered' ? settled.reason : settled.status;
			throw new Error(`[flue] The prompt ended without an answer: ${reason}.`);
		}
		const entries = await runEntries(conversation, settled.entry, context);
		let usage: PromptUsage = emptyUsage();
		let outcome: ReturnType<typeof resultFromToolDetails>;
		let answer: AssistantMessage | undefined;
		for (const entry of entries) {
			const message = entry.model?.[0];
			if (message?.role === 'assistant') {
				const added = fromProviderUsage(message.usage);
				if (added) usage = addUsage(usage, added);
				if (entry.id === settled.answer) answer = message;
			} else if (message?.role === 'toolResult' && !message.isError) {
				outcome ??= resultFromToolDetails(message.details);
			}
		}
		return {
			answer: {
				text: answerText(answer),
				usage,
				model: answer
					? { provider: answer.provider, id: answer.model }
					: this.#modelOf(conversation, context),
			},
			outcome,
		};
	}
}

/** A `FlueSession` over one Pi conversation of `host`. */
export function createPiSession(options: PiSessionOptions): FlueSession {
	return new PiSession(options);
}
