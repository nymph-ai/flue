/**
 * The entity tools facet (PI_UPGRADE_PLAN.md §2.5): `use()`s the three entity
 * services and registers the Pi `ToolRegistration`s `send_message`,
 * `publish_event`, `observe`, `spawn_agent` and `schedule_wake`. Pi sees five
 * ordinary tools; Electric, Cloudflare and the relay stay behind the services.
 *
 * Every tool is `replay: "safe"`: a rerun after recovery derives the same
 * message/event/schedule ids from `{self}/{taskId}/{callId}`, and the
 * provider commits nothing new for an id it already committed. Times relative
 * to now (`delay_ms`) are fixed through `api.memo` on first execution.
 */
import { type Context, defineFacet, type Facet, type JsonValue } from '@earendil-works/chord';
import { withContextValue } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import type { Registry, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { ENTITY_TOOL_CALL } from './facet.ts';
import { entityKey } from './paths.ts';
import {
	EntityLifecycle,
	type EntityLifecycleService,
	type EntityMessage,
	EntityMessaging,
	type EntityMessagingService,
	EntityObservation,
	type EntityObservationService,
	type EntityRef,
	type ObserveSource,
} from './services.ts';
import type { EntityToolName } from './tool-names.ts';

export interface EntityToolsFacetOptions {
	readonly registry: Registry<ToolRegistration>;
	readonly entity: EntityRef;
	readonly now?: () => number;
}

type Args = Record<string, unknown>;

const EntityRefSchema = Type.Object({
	type: Type.String({ description: 'Agent name of the entity.' }),
	id: Type.String({ description: 'Instance id of the entity.' }),
});

function text(value: string, details: JsonValue): ToolExecutionResult {
	return { content: [{ type: 'text', text: value }], details };
}

function failure(error: unknown): ToolExecutionResult {
	return {
		content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
		isError: true,
	};
}

function optionalString(args: Args, name: string): string | undefined {
	const value = args[name];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function entityArg(args: Args, name: string): EntityRef | undefined {
	const value = args[name];
	if (typeof value !== 'object' || value === null) return undefined;
	const ref = value as Record<string, unknown>;
	return typeof ref.type === 'string' && typeof ref.id === 'string' ? { type: ref.type, id: ref.id } : undefined;
}

function messageArg(args: Args): EntityMessage {
	const message: { text?: string; data?: JsonValue } = {};
	if (typeof args.text === 'string') message.text = args.text;
	if (args.data !== undefined) message.data = args.data as JsonValue;
	return message;
}

function callScoped(api: ToolExecutionApi, context: Context): Context {
	return withContextValue(ENTITY_TOOL_CALL, api, context);
}

export function createEntityToolsFacet(options: EntityToolsFacetOptions): Facet {
	const { registry, entity: self } = options;
	const now = options.now ?? Date.now;

	function tools(
		messaging: EntityMessagingService,
		observation: EntityObservationService,
		lifecycle: EntityLifecycleService,
	): (ToolRegistration & { readonly name: EntityToolName })[] {
		return [
			{
				name: 'send_message',
				description:
					'Send a durable message to another agent instance. It is delivered exactly once, even if that agent is asleep; it wakes to read it. Its reply, if any, arrives later as a new message.',
				parameters: Type.Object({
					target: EntityRefSchema,
					text: Type.Optional(Type.String({ description: 'The message text.' })),
					data: Type.Optional(Type.Unknown({ description: 'Structured JSON payload.' })),
					message_id: Type.Optional(
						Type.String({ description: 'Idempotency key; a repeat with the same id is delivered once.' }),
					),
				}),
				replay: 'safe',
				async execute(raw, api, context) {
					try {
						const args = raw as Args;
						const target = entityArg(args, 'target');
						if (!target) throw new Error('send_message needs target { type, id }.');
						const messageId = optionalString(args, 'message_id');
						const receipt = await messaging.send(
							target,
							messageArg(args),
							messageId === undefined ? {} : { messageId },
							callScoped(api, context),
						);
						return text(
							`Message ${receipt.messageId} ${receipt.deduplicated ? 'was already sent' : 'sent'} to ${entityKey(target)}.`,
							receipt,
						);
					} catch (error) {
						return failure(error);
					}
				},
			},
			{
				name: 'publish_event',
				description: "Publish an event to this agent's public events stream, which other agents can observe.",
				parameters: Type.Object({
					event: Type.Unknown({ description: 'The event, any JSON value.' }),
					event_id: Type.Optional(Type.String({ description: 'Idempotency key for the event.' })),
				}),
				replay: 'safe',
				async execute(raw, api, context) {
					try {
						const args = raw as Args;
						const eventId = optionalString(args, 'event_id');
						const result = await publishFromArgs(messaging, args, eventId, callScoped(api, context));
						return text(`Published event ${result.eventId}.`, result);
					} catch (error) {
						return failure(error);
					}
				},
			},
			{
				name: 'observe',
				description:
					"Observe a stream (another agent's events, or a named stream such as a world feed). New items are recorded in this conversation's history; with wake, new items wake this agent.",
				parameters: Type.Object({
					key: Type.String({ description: 'Name for this observation.' }),
					entity: Type.Optional(EntityRefSchema),
					stream: Type.Optional(Type.String({ description: 'A stream path, when not observing an agent.' })),
					from: Type.Optional(Type.String({ description: 'Start offset; "-1" reads from the beginning.' })),
					wake: Type.Optional(Type.Boolean({ description: 'Wake this agent when the stream grows.' })),
					poll: Type.Optional(Type.Boolean({ description: 'Also read what is there now.' })),
					limit: Type.Optional(Type.Number({ description: 'Most items to read now.' })),
				}),
				replay: 'safe',
				async execute(raw, api, context) {
					try {
						const args = raw as Args;
						const key = optionalString(args, 'key');
						if (!key) throw new Error('observe needs a key.');
						const target = entityArg(args, 'entity');
						const stream = optionalString(args, 'stream');
						const source: ObserveSource | undefined = target
							? { entity: target, channel: 'events' }
							: stream
								? { stream }
								: undefined;
						if (!source) throw new Error('observe needs an entity or a stream.');
						const scoped = callScoped(api, context);
						const from = optionalString(args, 'from');
						const observed = await observation.observe(
							source,
							{
								key,
								...(from === undefined ? {} : { from }),
								...(typeof args.wake === 'boolean' ? { wake: args.wake } : {}),
							},
							scoped,
						);
						if (args.poll !== true) return text(`Observing "${key}" from ${observed.offset}.`, observed);
						const limit = typeof args.limit === 'number' ? args.limit : undefined;
						const batch = await observation.poll(key, limit === undefined ? {} : { limit }, scoped);
						return text(
							`Observing "${key}"; ${batch.items.length} item(s) now:\n${batch.items.map((item) => JSON.stringify(item)).join('\n')}`,
							{ ...observed, nextOffset: batch.nextOffset, count: batch.items.length },
						);
					} catch (error) {
						return failure(error);
					}
				},
			},
			{
				name: 'spawn_agent',
				description:
					'Create a long-lived child agent instance (id "<this id>/<key>") of the given agent type, optionally with creation data and a first message. Spawning the same key again returns the same child.',
				parameters: Type.Object({
					type: Type.String({ description: 'Agent name of the child.' }),
					key: Type.String({ description: 'Child key; the child id is "<this id>/<key>".' }),
					initial_data: Type.Optional(Type.Unknown({ description: 'Creation data for the child.' })),
					text: Type.Optional(Type.String({ description: 'First message to the child.' })),
				}),
				replay: 'safe',
				async execute(raw, api, context) {
					try {
						const args = raw as Args;
						const type = optionalString(args, 'type');
						const key = optionalString(args, 'key');
						if (!type || !key) throw new Error('spawn_agent needs type and key.');
						const child = await lifecycle.spawn(
							type,
							{
								key,
								...(args.initial_data === undefined ? {} : { initialData: args.initial_data as JsonValue }),
								...(typeof args.text === 'string' ? { message: { text: args.text } } : {}),
							},
							callScoped(api, context),
						);
						return text(`Spawned ${entityKey(child)} (uid ${child.uid}).`, child);
					} catch (error) {
						return failure(error);
					}
				},
			},
			{
				name: 'schedule_wake',
				description:
					'Schedule a message to arrive later — for this agent (a reminder that wakes it) or for another agent instance.',
				parameters: Type.Object({
					text: Type.String({ description: 'What the message says when it arrives.' }),
					delay_ms: Type.Optional(Type.Number({ description: 'Milliseconds from now.' })),
					at_ms: Type.Optional(Type.Number({ description: 'Absolute time, epoch milliseconds.' })),
					target: Type.Optional(EntityRefSchema),
					schedule_id: Type.Optional(Type.String({ description: 'Id for the schedule (to cancel or move it).' })),
				}),
				replay: 'safe',
				async execute(raw, api, context) {
					try {
						const args = raw as Args;
						const scoped = callScoped(api, context);
						let atMs: number;
						if (typeof args.at_ms === 'number') atMs = args.at_ms;
						else if (typeof args.delay_ms === 'number') {
							atMs = await api.memo<number>('flue.schedule_wake.at', now() + args.delay_ms, scoped);
						} else throw new Error('schedule_wake needs delay_ms or at_ms.');
						const scheduleId = optionalString(args, 'schedule_id') ?? `${api.taskId}/${api.callId}`;
						const target = entityArg(args, 'target') ?? self;
						await lifecycle.schedule(target, atMs, messageArg(args), { scheduleId }, scoped);
						return text(
							`Scheduled "${scheduleId}" for ${entityKey(target)} at ${new Date(atMs).toISOString()}.`,
							{ scheduleId, atMs, target },
						);
					} catch (error) {
						return failure(error);
					}
				},
			},
		];
	}

	return defineFacet({
		id: 'flue.entity.tools',
		setup(env) {
			const messaging = env.use(EntityMessaging);
			const observation = env.use(EntityObservation);
			const lifecycle = env.use(EntityLifecycle);
			let registration: { dispose(): void } | undefined;
			env.onActivate(() => {
				registration = registry.batch(() => {
					for (const tool of tools(messaging, observation, lifecycle)) registry.tools.add(tool);
				});
			});
			env.onDeactivate(() => {
				registration?.dispose();
				registration = undefined;
			});
		},
	});
}

function publishFromArgs(
	messaging: EntityMessagingService,
	args: Args,
	eventId: string | undefined,
	context: Context,
): Promise<{ readonly eventId: string }> {
	return messaging.publish(
		(args.event === undefined ? null : args.event) as JsonValue,
		eventId === undefined ? {} : { eventId },
		context,
	);
}
