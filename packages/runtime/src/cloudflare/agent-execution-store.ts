import { SqliteConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { SqliteAttachmentStore } from '../sql-attachment-store.ts';
import type { SqlStorage } from '../sql-storage.ts';

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

/**
 * The Durable Object's attachment store and its pre-Pi conversation store
 * (read once, for the import). Both create their tables on first write, so
 * constructing them — before `super()`, on every activation — touches no
 * storage, and a new instance that never stores an attachment or holds a
 * legacy stream pays nothing for either (nymph-ai/nymphai #3868). A store
 * recorded with an unknown format version is refused by the first call that
 * finds its tables.
 */
export function createSqlConversationStores(storage: DurableObjectStorage) {
	const sql = storage.sql as SqlStorage;
	const transactionSync = storage.transactionSync as NonNullable<
		DurableObjectStorage['transactionSync']
	>;
	const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
	return {
		conversationStreamStore: new SqliteConversationStreamStore(sql, runTransaction),
		attachmentStore: new SqliteAttachmentStore(sql, runTransaction),
	};
}
