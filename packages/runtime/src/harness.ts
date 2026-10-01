/**
 * `FlueHarness` on Pi Durable (PI_UPGRADE_PLAN.md §1 `harness.ts` row): the
 * surface a `harness: true` tool and the lifecycle callbacks receive.
 * `prompt` and `compact` drive a scratch session — one Pi conversation per
 * harness, created on first use and continued by later calls — and
 * `sandbox` is the agent's live sandbox.
 *
 * A tool's harness conversation is owned by the tool's task, so aborting the
 * agent's work aborts it too, and the owner chain is the delegation depth
 * (capped at `MAX_DELEGATION_DEPTH`, which replaces the old recursion
 * lineage). Lifecycle harnesses are ownerless.
 */
import type { Context } from '@earendil-works/chord';
import type { ConversationId, ToolExecutionApi, Tx } from '@earendil-works/pi-durable';
import type * as v from 'valibot';
import { createCallHandle } from './abort.ts';
import { DelegationDepthExceededError } from './errors.ts';
import type { FlueExecutionContext } from './execution-interceptor.ts';
import type { FluePiHost } from './pi/host.ts';
import { MAX_DELEGATION_DEPTH } from './pi/subagent-tool.ts';
import type { FlueToolHarnessScope } from './pi/tools.ts';
import { createPiSession } from './session.ts';
import type {
	CallHandle,
	FlueEventInput,
	FlueHarness,
	FlueObservationDetail,
	FlueSession,
	PromptOptions,
	Sandbox,
} from './types.ts';

export interface PiHarnessOptions {
	readonly host: FluePiHost;
	/** Harness name on events (`default`). */
	readonly name: string;
	/** The live sandbox; throws when the agent declared none. */
	readonly sandbox: () => Sandbox;
	readonly emit: (event: FlueEventInput, observation?: FlueObservationDetail) => void;
	readonly executionContext: (fields?: Partial<FlueExecutionContext>) => FlueExecutionContext;
	readonly context: Context;
	/** Create the scratch conversation (first use only). */
	readonly createConversation: (context: Context) => Promise<ConversationId>;
}

class PiHarness implements FlueHarness {
	readonly name: string;
	readonly #options: PiHarnessOptions;
	#session: Promise<FlueSession> | undefined;

	constructor(options: PiHarnessOptions) {
		this.#options = options;
		this.name = options.name;
	}

	get sandbox(): Sandbox {
		return this.#options.sandbox();
	}

	#open(): Promise<FlueSession> {
		this.#session ??= (async () => {
			const conversationId = await this.#options.createConversation(this.#options.context);
			await this.#options.host.configure(conversationId, this.#options.context);
			return createPiSession({
				host: this.#options.host,
				conversationId,
				name: this.name,
				sandbox: this.#options.sandbox,
				emit: this.#options.emit,
				executionContext: this.#options.executionContext,
				context: this.#options.context,
			});
		})();
		const pending = this.#session;
		pending.catch(() => {
			if (this.#session === pending) this.#session = undefined;
		});
		return pending;
	}

	prompt(text: string, options?: PromptOptions<v.GenericSchema | undefined>): CallHandle<any> {
		return createCallHandle(options?.signal, async (signal) => {
			const session = await this.#open();
			return session.prompt(text, { ...options, signal } as PromptOptions);
		});
	}

	async compact(): Promise<void> {
		const session = await this.#open();
		await session.compact();
	}
}

/** Owner hops from `conversationId` up to an ownerless conversation. */
async function ownerDepth(tx: Tx, conversationId: ConversationId): Promise<number> {
	let depth = 0;
	let current = await tx.conversation(conversationId);
	while (current?.owner !== undefined) {
		depth += 1;
		current = await tx.conversation(current.owner.conversationId);
	}
	return depth;
}

/**
 * The harness of one `harness: true` tool call: its scratch conversation is
 * owned by the call's task. Closing it is a no-op — the conversation is
 * durable history, and ownership ends its work with the call.
 */
export function createToolHarness(
	options: Omit<PiHarnessOptions, 'createConversation' | 'name'> & {
		readonly api: ToolExecutionApi;
	},
): FlueToolHarnessScope {
	const { api } = options;
	const harness = new PiHarness({
		...options,
		name: 'default',
		createConversation: (context) =>
			api.commit(async (tx) => {
				const depth = await ownerDepth(tx, api.conversationId);
				if (depth >= MAX_DELEGATION_DEPTH) {
					throw new DelegationDepthExceededError({ maxDepth: MAX_DELEGATION_DEPTH });
				}
				return (await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } }))
					.id;
			}, context),
	});
	return { harness, close: async () => {} };
}

/** The `ctx.harness` of a lifecycle callback: an ownerless scratch conversation. */
export function createLifecycleHarness(
	options: Omit<PiHarnessOptions, 'createConversation' | 'name'>,
): FlueHarness {
	return new PiHarness({
		...options,
		name: 'default',
		createConversation: async (context) =>
			(await options.host.harness.createConversation({ ownership: { kind: 'ownerless' } }, context))
				.id,
	});
}
