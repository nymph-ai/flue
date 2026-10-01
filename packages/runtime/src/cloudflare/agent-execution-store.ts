import { describeErrorChain, formatErrorForLog } from '../errors.ts';
import { SqliteConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import { ensureSqlAttachmentTable, SqliteAttachmentStore } from '../sql-attachment-store.ts';
import type { SqlStorage } from '../sql-storage.ts';

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

/**
 * Wrap a store-initialization failure so it survives the Durable Object
 * boundary. These wrappers run in the DO constructor: the throw tunnels
 * across `stub.fetch()` message-only, so the full cause chain is flattened
 * into the message, and the real error — stacks and all — is logged DO-side
 * first. That log line is the only place the original stack ever exists, and
 * the only coverage for alarm-driven wakes that have no HTTP caller at all.
 * The constructor-throw semantics stay: a DO that cannot open its storage
 * fails loudly and lets the platform re-instantiate on the next request.
 */
function initFailure(className: string, what: string, cause: unknown): Error {
	const wrapped = new Error(
		`[flue] Cloudflare durable agent class "${className}" could not initialize its ${what}. ` +
			`Underlying error: ${describeErrorChain(cause)}`,
		{ cause },
	);
	console.error(formatErrorForLog(wrapped));
	return wrapped;
}

export function createSqlConversationStores(storage: DurableObjectStorage, className: string) {
	const sql = storage.sql as SqlStorage;
	const transactionSync = storage.transactionSync as NonNullable<
		DurableObjectStorage['transactionSync']
	>;
	const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
	try {
		ensureSqlAttachmentTable(sql);
		return {
			conversationStreamStore: new SqliteConversationStreamStore(sql, runTransaction),
			attachmentStore: new SqliteAttachmentStore(sql, runTransaction),
		};
	} catch (cause) {
		throw initFailure(className, 'SQLite conversation stores', cause);
	}
}
