/**
 * EntityWakeBook: alias for FlueReactorStore.
 *
 * FlueReactorStore owns the two tables in the entity's SQLite:
 * 1. `flue_entity_streams`: inbound streams, head, committed cursor
 * 2. `flue_outbox`: outbound semantic effects (undelivered obligations only)
 */
export {
	FlueReactorStore,
	FlueReactorStore as EntityWakeBook,
	type OutboxEntry,
	type WakeStreamState,
} from '../reactor/reactor-store.ts';
