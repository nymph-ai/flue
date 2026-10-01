/**
 * The event context of one agent instance: identity, environment, logging,
 * and the decorated `FlueEvent` emission every runtime event goes through
 * (per-context subscribers, then `observe()` subscribers). Agent execution
 * itself lives on the Pi host (`runtime/agent-instance.ts`).
 */
import { normalizeLogAttributes } from './errors.ts';
import { dispatchGlobalEvent } from './runtime/events.ts';
import type {
	AgentConfig,
	FlueEvent,
	FlueEventCallback,
	FlueEventContext,
	FlueEventInput,
	FlueObservationDetail,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	agentName?: string;
	/**
	 * The submission this context processes, when known at construction, so
	 * emitted events carry it from the first event on.
	 */
	submissionId?: string;
	env: Record<string, any>;
	/**
	 * Host-provided agent-config seeds. Kept for the generated entries'
	 * call shape; the model is resolved through `runtime/providers.ts`.
	 */
	agentConfig?: Partial<Omit<AgentConfig, 'systemPrompt' | 'skills' | 'model'>>;
	/**
	 * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
	 */
	req?: Request;
}

/** Extends FlueEventContext with server-only methods. */
export interface FlueContextInternal extends FlueEventContext {
	createEvent(event: FlueEventInput): FlueEvent;
	publishEvent(event: FlueEvent, observation?: FlueObservationDetail): void;
	emitEvent(event: FlueEventInput, observation?: FlueObservationDetail): FlueEvent;
	subscribeEvent(callback: FlueEventCallback): () => void;
	flushEventCallbacks(): Promise<void>;
	setEventCallback(callback: FlueEventCallback | undefined): void;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	const subscribers = new Set<FlueEventCallback>();
	let handlerUnsubscribe: (() => void) | undefined;
	const pendingEventCallbacks = new Set<Promise<void>>();
	let eventCallbackError: unknown;
	let eventIndex = 0;

	const createEvent = (event: FlueEventInput): FlueEvent => ({
		...event,
		instanceId: config.id,
		// Payload wins for submissionId: the context stamps its own only when
		// the emission didn't set one.
		...(event.submissionId === undefined && config.submissionId !== undefined
			? { submissionId: config.submissionId }
			: {}),
		...(config.agentName === undefined ? {} : { agentName: config.agentName }),
		v: 3,
		eventIndex: eventIndex++,
		timestamp: new Date().toISOString(),
	});

	const publishEvent = (decorated: FlueEvent, observation?: FlueObservationDetail): void => {
		for (const subscriber of subscribers) {
			try {
				const callback = subscriber(decorated);
				if (callback instanceof Promise) {
					const pending = callback
						.catch((error) => {
							eventCallbackError ??= error;
						})
						.finally(() => pendingEventCallbacks.delete(pending));
					pendingEventCallbacks.add(pending);
				}
			} catch (error) {
				eventCallbackError ??= error;
			}
		}
		// Module-scoped `observe()` subscribers run after the per-context ones
		// and receive the originating context as a second argument.
		dispatchGlobalEvent(decorated, ctx, observation);
	};

	const emitEvent = (event: FlueEventInput, observation?: FlueObservationDetail): FlueEvent => {
		const decorated = createEvent(event);
		publishEvent(decorated, observation);
		return decorated;
	};

	const ctx: FlueContextInternal = {
		get id() {
			return config.id;
		},

		get agentName() {
			return config.agentName;
		},

		get env() {
			return config.env;
		},

		get req() {
			return config.req;
		},

		log: {
			info(message, attributes) {
				emitEvent({
					type: 'log',
					level: 'info',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
			warn(message, attributes) {
				emitEvent({
					type: 'log',
					level: 'warn',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
			error(message, attributes) {
				emitEvent({
					type: 'log',
					level: 'error',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
		},

		createEvent,

		publishEvent,

		emitEvent,

		subscribeEvent(callback: FlueEventCallback): () => void {
			subscribers.add(callback);
			return () => subscribers.delete(callback);
		},

		async flushEventCallbacks(): Promise<void> {
			await Promise.all(pendingEventCallbacks);
			if (eventCallbackError !== undefined) {
				const error = eventCallbackError;
				eventCallbackError = undefined;
				throw error;
			}
		},

		setEventCallback(callback: FlueEventCallback | undefined): void {
			handlerUnsubscribe?.();
			handlerUnsubscribe = callback ? ctx.subscribeEvent(callback) : undefined;
		},
	};

	return ctx;
}
