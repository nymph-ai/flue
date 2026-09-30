/**
 * Pi's `SqliteDatabase` facade over `node:sqlite`, for `StreamStorage` on
 * Node. Pi Durable 0.99.2 ships exactly this adapter (`BEGIN IMMEDIATE` /
 * `COMMIT`, rollback-then-rethrow, WAL with a busy timeout), so Flue reuses it
 * rather than keeping a second copy.
 */
export {
	NodeSqliteDatabase,
	type NodeSqliteStorageOptions,
	openNodeSqliteDatabase,
} from '@earendil-works/pi-durable/storage/sqlite/node';
