/**
 * `@flue/runtime/qualification` — the internals a live qualification of a
 * deployed Flue app needs and no app should: the entity stream paths, the
 * configured Electric streams, and the Durable Object SQLite facade with its
 * row counters.
 *
 * Nothing here is part of the authoring surface. It exists so a test-only
 * build (`examples/library` with `QUALIFICATION=1`) can drive entity
 * doorbells and measure storage cost against a real deployment.
 */
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
	type DurableObjectSqliteStorage,
	doSqliteDatabase,
	type SqliteRowCounters,
} from '../cloudflare/do-sqlite-database.ts';
import { type EntityAddress, entityStreamRoot } from '../entity/events.ts';
import { entityKey, eventsPath, inboxPath, wirePath } from '../entity/paths.ts';
import { EntityWakeBook } from '../entity/wake-book.ts';
import { ElectricDurableStreamLog } from '../streams/electric-log.ts';
import type { DurableStreamLog } from '../streams/log.ts';

export type { DurableObjectSqliteStorage, DurableStreamLog, EntityAddress, SqliteRowCounters };
export {
	doSqliteDatabase,
	ElectricDurableStreamLog,
	EntityWakeBook,
	entityKey,
	entityStreamRoot,
	eventsPath,
	inboxPath,
	wirePath,
};
export {
	configuredStreams,
	configuredStreamsLog,
	streamsSubscriptions,
} from '../runtime/streams-config.ts';

export const qualificationContext: Context = BACKGROUND_CONTEXT;

/** Rows a Durable Object's SQLite read and wrote through Flue's facade since the object started. */
export function durableObjectRows(storage: DurableObjectSqliteStorage): SqliteRowCounters {
	return { ...doSqliteDatabase(storage).rows };
}
