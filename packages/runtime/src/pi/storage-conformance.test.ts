import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { describe, expect, it } from 'vitest';
import { openNodeSqliteDatabase } from '../node/node-sqlite-database.ts';

registerStorageConformance(
	{ describe, expect, it },
	'MemoryStorage (Pi reference)',
	async (use) => {
		const storage = new MemoryStorage();
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT).catch(() => {});
		}
	},
);

// What Node agent instances run on: Pi's own SqliteStorage over Flue's
// row-counting node:sqlite facade.
registerStorageConformance(
	{ describe, expect, it },
	'SqliteStorage over the Node facade',
	async (use) => {
		const storage = await SqliteStorage.open(await openNodeSqliteDatabase(':memory:'));
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT).catch(() => {});
		}
	},
);
