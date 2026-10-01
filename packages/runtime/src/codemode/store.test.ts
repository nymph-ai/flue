/**
 * `codemode.store()`'s document checkpoints itself (nymph-ai/nymphai #3862)
 * and stays rewindable: with a base every `DELTAS_PER_BASE` writes, a read
 * as of any earlier entry still returns the values written by then.
 */
import { createModels } from '@earendil-works/pi-ai';
import {
	createRegistry,
	type EntryId,
	Harness,
	ROOT_CONVERSATION_ID,
	type ToolRegistration,
} from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { describe, expect, it } from 'vitest';
import { context, removeTempFiles, tempFile } from '../entity/a2a-test-support.ts';
import { openNodeSqliteDatabase } from '../node/node-sqlite-database.ts';
import { DELTAS_PER_BASE } from '../pi/docs.ts';
import { FlueCodemodeStore } from './store.ts';

describe('the codemode.store() document', () => {
	it('reads every past state as of its entry, with bases interleaved', async () => {
		const file = await tempFile('codemode-store.sqlite');
		const storage = await SqliteStorage.open(await openNodeSqliteDatabase(file));
		const harness = await Harness.open(
			storage,
			{ models: createModels(), registry: createRegistry<ToolRegistration>() },
			context,
		);
		await harness.root(context);
		const writes = DELTAS_PER_BASE * 10 + 2;
		const at: EntryId[] = [];
		for (let n = 1; n <= writes; n++) {
			const entry = await harness.commit(async (tx) => {
				const doc = await tx.doc(FlueCodemodeStore, ROOT_CONVERSATION_ID);
				doc.values.count = n;
				if (n % 3 === 0) delete doc.values.every3;
				else doc.values.every3 = `w${n}`;
				return tx.appendEntry(ROOT_CONVERSATION_ID, {
					kind: 'flue.data',
					data: { name: 'write', data: n },
				});
			}, context);
			at.push(entry.id);
		}
		for (let n = 1; n <= writes; n++) {
			const past = await harness.snapshotAsOf(
				FlueCodemodeStore,
				ROOT_CONVERSATION_ID,
				at[n - 1] as EntryId,
				context,
			);
			expect(past?.values).toEqual({ count: n, ...(n % 3 === 0 ? {} : { every3: `w${n}` }) });
		}
		const current = await harness.snapshot(FlueCodemodeStore, ROOT_CONVERSATION_ID, context);
		expect(current?.values.count).toBe(writes);

		// A cold read replays at most DELTAS_PER_BASE revisions after the newest base.
		await harness.close(context);
		const database = await openNodeSqliteDatabase(file);
		const reopened = await Harness.open(
			await SqliteStorage.open(database),
			{ models: createModels(), registry: createRegistry<ToolRegistration>() },
			context,
		);
		const before = { ...database.rows };
		await reopened.snapshot(FlueCodemodeStore, ROOT_CONVERSATION_ID, context);
		expect(database.rows.rowsRead - before.rowsRead).toBeLessThanOrEqual(DELTAS_PER_BASE + 8);
		await reopened.close(context);
		await removeTempFiles();
	});
});
