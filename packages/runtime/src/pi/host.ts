/**
 * `FluePiHost`: the single Flue adapter over Pi Durable 0.99.2
 * (PI_UPGRADE_PLAN.md §2.1, §7 step 6). Pi owns the loop, compaction,
 * retries, recovery, the inbox and ownership cascades; this host maps
 * Flue's contracts onto them — renders onto the registry, deliveries onto
 * submissions with receipts, lifecycle hooks onto generation hooks — and
 * never reaches past Pi's public API.
 *
 * Platform ports are injected (`storage`, `armWake`, the sandbox, MCP and
 * attachment ports), so nothing here is Electric- or Cloudflare-specific and
 * nothing imports `node:`. The coordinators are cut over to it in step 8.
 */
import type { Context } from '@earendil-works/chord';
import type { Models } from '@earendil-works/pi-ai';
import {
	type ConversationId,
	createRegistry,
	GenerationTask,
	Harness,
	type Registration,
	type Registry,
	ROOT_CONVERSATION_ID,
	type Storage,
	type SubmissionId,
	type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { Sandbox } from '../sandbox.ts';
import type { DispatchReceipt, FlueHarness, FlueLogger, SubagentDefinition } from '../types.ts';
import { FlueReceipts, FlueSessions } from './docs.ts';
import { executionEnvFromSandbox } from './execution-env.ts';
import { type FlueAttachmentPort, lifecycleHooks } from './hooks.ts';
import {
	admitSubmission,
	completeAdmission,
	countAttempts,
	enforceTimeouts,
	type FlueAdmission,
	type FlueSettlement,
	readSettlement,
	repairAdmissions,
} from './receipts.ts';
import { type McpToolResolver, type RenderedAgent, RegistryBridge } from './registry-bridge.ts';
import {
	createSubagentToolRegistration,
	DelegateTask,
	type DelegateResult,
	prepareDelegation,
	runDelegatedTask,
} from './subagent-tool.ts';
import type { ToolDefinition } from '../tool-types.ts';
import { type FlueToolDeps, flueToolRegistration } from './tools.ts';

export type { FlueAdmission, FlueSettlement } from './receipts.ts';
export type { RenderedAgent } from './registry-bridge.ts';

/** The entity a host serves: Flue agent name + instance id (`entity/services.ts` `EntityRef`). */
export type FluePiEntity = { readonly type: string; readonly id: string };

export type WakeReason =
	| { readonly kind: 'outbox' }
	| { readonly kind: 'live-tasks' }
	| { readonly kind: 'schedule'; readonly scheduleId: string }
	| { readonly kind: 'inbox'; readonly stream: string; readonly tailOffset: string }
	| { readonly kind: 'dispatch' };

/** Backstop wake while Pi has live tasks, so an evicted instance resumes them (§2.5). */
export const LIVE_TASK_BACKSTOP_MS = 30_000;

export interface FluePiHostOptions {
	readonly entity: FluePiEntity;
	/** pi-ai model access (`runtime/providers.ts`). */
	readonly models: Models;
	/** Opens the Pi storage: `StreamStorage` in production, any Pi `Storage` in tests. */
	readonly storage: () => Promise<Storage>;
	/** The instance sandbox: Flue's `grep`/`glob` run over it; `env` defaults to it. */
	readonly sandbox?: Sandbox;
	/** Pi execution environment for `read`/`write`/`edit`/`bash`. Default: `executionEnvFromSandbox(sandbox)`. */
	readonly env?: ExecutionEnv;
	readonly now?: () => number;
	readonly onReport: (error: unknown) => void;
	/** Arm a wake at `atMs` (DO alarm / Node timer). */
	readonly armWake: (atMs: number, reason: WakeReason) => Promise<void>;
	/** Validate and parse creation data against the agent's `initialData` schema. */
	readonly parseInitialData?: (initialData: unknown) => unknown;
	/** Harness binding for `harness: true` tools, and progress loggers. */
	readonly tools?: FlueToolDeps;
	/** Resolves `useMcpConnection` declarations (lane-mcp). */
	readonly mcp?: McpToolResolver;
	/** Keeps attachment bytes out of the canonical log. */
	readonly attachments?: FlueAttachmentPort;
	/** `ctx.harness` for lifecycle callbacks. */
	readonly lifecycleHarness?: (conversationId: ConversationId, context: Context) => FlueHarness;
	readonly logger?: (source: string) => FlueLogger;
}

/** A programmatic delegation (`session.task()`): a declared subagent by name, or a definition. */
export interface FlueTaskRequest {
	readonly agent: string | SubagentDefinition;
	readonly prompt: string;
}

export interface FluePiHost {
	/** The open Harness; throws before `open()`. */
	readonly harness: Harness;
	readonly registry: Registry<ToolRegistration>;
	/** Open storage and the Harness, ensure the root conversation, count attempts. Scheduling stays paused. */
	open(context: Context): Promise<void>;
	/** Publish one render: registry batch plus model/thinking/tools/compaction of every session. */
	applyRender(render: RenderedAgent, context: Context): Promise<void>;
	/** The Pi conversation behind a Flue session (`undefined` = root), created on first use. */
	conversation(session: string | undefined, context: Context): Promise<ConversationId>;
	/** Two-commit admission; returns the Flue receipt (deduplicated on a same-payload retry). */
	admit(input: FlueAdmission, context: Context): Promise<DispatchReceipt>;
	settlement(submissionId: string, context: Context): Promise<FlueSettlement | undefined>;
	waitForSettlement(submissionId: string, context: Context): Promise<FlueSettlement>;
	/** Abort one submission, or every session when `undefined`. */
	abort(submissionId: string | undefined, context: Context): Promise<boolean>;
	/** Repair admissions, enforce timeouts, resume scheduling, re-arm the next wake. */
	wake(reason: WakeReason, context: Context): Promise<void>;
	/** `session.task()`: delegate to a declared subagent and wait for its answer. */
	task(
		session: string | undefined,
		request: FlueTaskRequest,
		context: Context,
	): Promise<DelegateResult>;
	/** `task()` from any conversation (a harness scratch session). */
	taskIn(
		conversationId: ConversationId,
		request: FlueTaskRequest,
		context: Context,
	): Promise<DelegateResult>;
	/** The render applied last, if any. */
	readonly render: RenderedAgent | undefined;
	/** Tool names the current render offers its conversations. */
	activeToolNames(): string[];
	/** Give one more conversation (a harness scratch session) the current render's configuration. */
	configure(conversationId: ConversationId, context: Context): Promise<void>;
	/** Register call-scoped tools (a prompt's `tools` option, its result tools) until disposed. */
	addTools(tools: readonly ToolDefinition[], extra?: readonly ToolRegistration[]): Registration;
	close(context: Context): Promise<void>;
}

class PiHost implements FluePiHost {
	readonly registry: Registry<ToolRegistration>;
	readonly #options: FluePiHostOptions;
	readonly #bridge: RegistryBridge;
	readonly #env: ExecutionEnv | undefined;
	readonly #now: () => number;
	#harness: Harness | undefined;

	constructor(options: FluePiHostOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#env =
			options.env ??
			(options.sandbox ? executionEnvFromSandbox(options.sandbox, options.sandbox.cwd) : undefined);
		this.registry = createRegistry<ToolRegistration>();
		this.registry.tasks.add(DelegateTask);
		const delegation = {
			rosterFor: (...args: Parameters<RegistryBridge['rosterFor']>) =>
				this.#bridge.rosterFor(...args),
			registerDelegate: (...args: Parameters<RegistryBridge['registerDelegate']>) =>
				this.#bridge.registerDelegate(...args),
		};
		this.#bridge = new RegistryBridge({
			registry: this.registry,
			models: options.models,
			...(options.sandbox ? { sandbox: options.sandbox } : {}),
			...(options.tools ? { tools: options.tools } : {}),
			...(options.mcp ? { mcp: options.mcp } : {}),
			taskTool: createSubagentToolRegistration(delegation),
			onReport: options.onReport,
		});
		this.registry.hooks.add(
			GenerationTask,
			lifecycleHooks({
				lifecycle: (conversationId, read, context) =>
					this.#bridge.lifecycleFor(conversationId, read, context),
				commit: (change, context) => this.harness.commit(change, context),
				write: async (conversationId, entry, requestId, context) => {
					const conversation = await this.harness.conversation(conversationId, context);
					await conversation?.submit({ type: 'write', entry, requestId }, context);
				},
				...(options.attachments ? { attachments: options.attachments } : {}),
				...(options.lifecycleHarness ? { harness: options.lifecycleHarness } : {}),
				...(options.logger ? { logger: options.logger } : {}),
				now: this.#now,
				onReport: options.onReport,
			}),
			{ key: 'flue.lifecycle' },
		);
	}

	get harness(): Harness {
		if (!this.#harness) throw new Error('[flue] The Pi host is not open.');
		return this.#harness;
	}

	async open(context: Context): Promise<void> {
		if (this.#harness) return;
		const storage = await this.#options.storage();
		this.#harness = await Harness.open(
			storage,
			{
				models: this.#options.models,
				registry: this.registry,
				...(this.#env ? { env: this.#env } : {}),
				now: this.#now,
				onReport: this.#options.onReport,
			},
			context,
		);
		await this.#harness.root(context);
		await countAttempts(this.#harness, context);
	}

	async #sessionConversations(context: Context): Promise<ConversationId[]> {
		const sessions = await this.harness.snapshot(FlueSessions, context);
		return [
			ROOT_CONVERSATION_ID,
			...Object.values(sessions?.sessions ?? {}).map((id) => id as ConversationId),
		];
	}

	async applyRender(render: RenderedAgent, context: Context): Promise<void> {
		const conversations = [];
		for (const id of await this.#sessionConversations(context)) {
			const conversation = await this.harness.conversation(id, context);
			if (conversation) conversations.push(conversation);
		}
		await this.#bridge.apply(render, conversations, context);
	}

	async conversation(session: string | undefined, context: Context): Promise<ConversationId> {
		if (session === undefined) return ROOT_CONVERSATION_ID;
		const known = (await this.harness.snapshot(FlueSessions, context))?.sessions[session];
		if (known !== undefined) return known as ConversationId;
		const id = await this.harness.commit(async (tx) => {
			const sessions = await tx.doc(FlueSessions);
			const existing = sessions.sessions[session];
			if (existing !== undefined) return existing;
			const created = await tx.createConversation({ ownership: { kind: 'ownerless' } });
			sessions.sessions[session] = created.id;
			return created.id;
		}, context);
		await this.configure(id as ConversationId, context);
		return id as ConversationId;
	}

	async admit(input: FlueAdmission, context: Context): Promise<DispatchReceipt> {
		const isNewSession =
			input.session !== undefined &&
			(await this.harness.snapshot(FlueSessions, context))?.sessions[input.session] === undefined;
		if (isNewSession) await this.conversation(input.session, context);
		return admitSubmission(
			this.harness,
			this.#options.entity,
			input,
			{
				...(this.#options.parseInitialData
					? { parseInitialData: this.#options.parseInitialData }
					: {}),
				...(this.#options.attachments ? { attachments: this.#options.attachments } : {}),
			},
			context,
		);
	}

	settlement(submissionId: string, context: Context): Promise<FlueSettlement | undefined> {
		return readSettlement(this.harness, submissionId, this.#now, context);
	}

	async waitForSettlement(submissionId: string, context: Context): Promise<FlueSettlement> {
		let receipt = await this.harness.snapshot(FlueReceipts, submissionId, context);
		if (receipt === undefined || receipt.status === 'absent') {
			throw new Error(`[flue] Unknown submission ${submissionId}.`);
		}
		if (receipt.status === 'admitting')
			receipt = await completeAdmission(this.harness, submissionId, context);
		const submission = await this.harness.submission(
			receipt.piSubmissionId as SubmissionId,
			context,
		);
		if (!submission)
			throw new Error(`[flue] invariant: submission ${submissionId} lost its Pi submission.`);
		await submission.wait(context);
		const settlement = await this.settlement(submissionId, context);
		if (!settlement)
			throw new Error(`[flue] invariant: submission ${submissionId} settled without a settlement.`);
		return settlement;
	}

	async abort(submissionId: string | undefined, context: Context): Promise<boolean> {
		if (submissionId === undefined) {
			for (const id of await this.#sessionConversations(context)) {
				await (await this.harness.conversation(id, context))?.abort(context);
			}
			return true;
		}
		let receipt = await this.harness.snapshot(FlueReceipts, submissionId, context);
		if (receipt === undefined || receipt.status === 'absent') return false;
		if (receipt.status === 'admitting')
			receipt = await completeAdmission(this.harness, submissionId, context);
		const outcome = await this.harness.abortSubmission(
			receipt.piSubmissionId as SubmissionId,
			context,
		);
		if (outcome === 'aborted') return true;
		if (outcome === 'already_placed') {
			await (
				await this.harness.conversation(receipt.conversationId as ConversationId, context)
			)?.abort(context);
			return true;
		}
		return false;
	}

	async wake(_reason: WakeReason, context: Context): Promise<void> {
		const harness = this.harness;
		await repairAdmissions(harness, context);
		const deadline = await enforceTimeouts(harness, this.#now(), context);
		harness.resume();
		if (deadline !== undefined) await this.#options.armWake(deadline, { kind: 'live-tasks' });
		const inspection = await harness.inspect(context);
		if (inspection.tasks.length > 0) {
			await this.#options.armWake(this.#now() + LIVE_TASK_BACKSTOP_MS, { kind: 'live-tasks' });
		}
	}

	get render(): RenderedAgent | undefined {
		return this.#bridge.current;
	}

	activeToolNames(): string[] {
		return this.#bridge.activeToolNames();
	}

	addTools(
		tools: readonly ToolDefinition[],
		extra: readonly ToolRegistration[] = [],
	): Registration {
		return this.registry.batch(() => {
			for (const tool of tools)
				this.registry.tools.add(flueToolRegistration(tool, this.#options.tools));
			for (const tool of extra) this.registry.tools.add(tool);
		});
	}

	async configure(conversationId: ConversationId, context: Context): Promise<void> {
		const render = this.#bridge.current;
		const conversation = await this.harness.conversation(conversationId, context);
		if (render && conversation)
			await this.#bridge.apply(render, [conversation], context, { force: true });
	}

	async task(
		session: string | undefined,
		request: FlueTaskRequest,
		context: Context,
	): Promise<DelegateResult> {
		return this.taskIn(await this.conversation(session, context), request, context);
	}

	async taskIn(
		conversationId: ConversationId,
		request: FlueTaskRequest,
		context: Context,
	): Promise<DelegateResult> {
		const roster = await this.#bridge.rosterFor(conversationId, this.harness, context);
		const subagent =
			typeof request.agent === 'string'
				? roster.find((candidate) => candidate.name === request.agent)
				: request.agent;
		if (!subagent) {
			throw new Error(
				`[flue] Subagent "${request.agent}" is not declared. Available: ${roster.map((each) => each.name).join(', ') || 'none'}.`,
			);
		}
		const input = prepareDelegation(this.#bridge, subagent, request.prompt);
		return runDelegatedTask(this.harness, conversationId, input, context);
	}

	async close(context: Context): Promise<void> {
		const harness = this.#harness;
		this.#harness = undefined;
		await harness?.close(context);
	}
}

/** Create the Flue Pi host for one agent instance. Call `open()` before anything else. */
export function createFluePiHost(options: FluePiHostOptions): FluePiHost {
	return new PiHost(options);
}
