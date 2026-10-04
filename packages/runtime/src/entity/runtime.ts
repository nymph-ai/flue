/**
 * One entity's A2A runtime: the Chord facet host that provides the entity
 * services and registers the entity tools on a `FluePiHost`, plus the inbox
 * consumer, schedule book and observation book the alarm pump drives
 * (`pump.ts`).
 *
 * Construct it right after `createFluePiHost` and before the first
 * `applyRender`, so the entity tools are registered when the render picks a
 * conversation's active tools. Its services touch `host.harness` only when
 * called, so the host may open later.
 */
import { type Context, createFacetHost, type FacetHost } from '@earendil-works/chord';
import type { FluePiHost } from '../pi/host.ts';
import type { DurableStreamLog } from '../streams/log.ts';
import { createEntityFacet, type EntitySubscriptionPort } from './facet.ts';
import { InboxConsumer } from './inbox.ts';
import { createEntityQuestionHandler } from './questions.ts';
import { ObservationBook } from './observations.ts';
import { ScheduleBook } from './schedules.ts';
import {
	EntityLifecycle,
	type EntityLifecycleService,
	EntityMessaging,
	type EntityMessagingService,
	EntityObservation,
	type EntityObservationService,
	type EntityRef,
} from './services.ts';
import { createEntityToolsFacet } from './tools-facet.ts';

import type { SemanticEmitter } from '../reactor/reactor.ts';

export interface EntityRuntimeOptions {
	readonly host: FluePiHost;
	readonly entity: EntityRef;
	readonly log: DurableStreamLog;
	/** Electric subscription management for `observe({ wake: true })` (`subscriptions.ts`). */
	readonly subscriptions?: EntitySubscriptionPort;
	readonly now?: () => number;
	readonly onReport?: (error: unknown) => void;
	/** Semantic emitter for outbox-backed durable delivery. */
	readonly emitter: SemanticEmitter;
}

export interface EntityRuntime {
	readonly entity: EntityRef;
	readonly host: FluePiHost;
	readonly messaging: EntityMessagingService;
	readonly observation: EntityObservationService;
	readonly lifecycle: EntityLifecycleService;
	readonly inbox: InboxConsumer;
	readonly schedules: ScheduleBook;
	readonly observations: ObservationBook;
	readonly facets: FacetHost;
	/** Republish `EntityObservation.cursors` from the Pi docs (after open). */
	refreshCursors(context: Context): Promise<void>;
	dispose(): Promise<void>;
}

export async function createEntityRuntime(options: EntityRuntimeOptions): Promise<EntityRuntime> {
	const now = options.now ?? Date.now;
	const onReport = options.onReport ?? (() => {});
	const { host, entity, log, emitter } = options;
	// Questions to people are entity events (rule 9): this instance's handler.
	host.setQuestionHandler(
		createEntityQuestionHandler({
			entity,
			log,
			settings: () => host.render?.questions,
			now,
			onReport,
			emitter,
		}),
	);
	const schedules = new ScheduleBook({ host, now, onReport });
	const observations = new ObservationBook({ host, log, now });
	const inbox = new InboxConsumer({
		host,
		entity,
		log,
		schedules,
		now,
		onReport,
	});
	const cursorSink: { refresh?: (context: Context) => Promise<void> } = {};
	const facets = await createFacetHost({
		facets: [
			createEntityFacet({
				host,
				entity,
				log,
				observations,
				schedules,
				cursorSink,
				...(options.subscriptions ? { subscriptions: options.subscriptions } : {}),
				emitter,
			}),
			createEntityToolsFacet({ registry: host.registry, entity, now }),
		],
		onError: (error) => onReport(error),
	});
	return {
		entity,
		host,
		messaging: facets.services.use(EntityMessaging),
		observation: facets.services.use(EntityObservation),
		lifecycle: facets.services.use(EntityLifecycle),
		inbox,
		schedules,
		observations,
		facets,
		async refreshCursors(context) {
			await cursorSink.refresh?.(context);
		},
		dispose: () => facets.dispose(),
	};
}
