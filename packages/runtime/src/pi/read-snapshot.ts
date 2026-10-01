/**
 * A snapshot of every Pi read API over a `Storage`, including historical
 * document reads at every seq up to `lastSeq`: what "the same Pi Durable
 * materialization" means when a rebuilt index is compared with a live one.
 * Used by the StreamStorage tests and by live qualification
 * (`@flue/runtime/qualification`), so it imports no test framework.
 */
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Cursor, Seq, Storage } from '@earendil-works/pi-durable';

const context: Context = BACKGROUND_CONTEXT;

async function scanAll<T>(
	scan: (
		cursor: Cursor | undefined,
	) => Promise<{ readonly items: readonly T[]; readonly next?: Cursor }>,
): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

async function settle<T>(read: () => Promise<T>): Promise<T | { readonly error: string }> {
	try {
		return await read();
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Every Pi read API over everything `storage` holds, including historical
 * document reads at every seq up to `lastSeq`. Small pages exercise cursors.
 */
export async function snapshotReads(
	storage: Storage,
	lastSeq: number,
): Promise<Record<string, unknown>> {
	const snapshot: Record<string, unknown> = {};
	const conversations = await scanAll((cursor) =>
		storage.scanConversations({}, 2, cursor, context),
	);
	snapshot.conversations = conversations;
	const scopes: { kind: string; [key: string]: unknown }[] = [{ kind: 'session' }];
	for (const conversation of conversations) {
		const id = conversation.id;
		scopes.push({ kind: 'conversation', conversationId: id });
		const entries = await scanAll((cursor) =>
			storage.scanEntries({ conversationId: id }, 3, cursor, context),
		);
		snapshot[`entries:${id}`] = entries;
		snapshot[`head:${id}`] = await storage.findLatestHeadMarker(id, undefined, context);
		for (const entry of entries) {
			snapshot[`entry:${entry.id}`] = await storage.entry(entry.id, context);
			snapshot[`entry:${id}/${entry.id}`] = await storage.entry(id, entry.id, context);
			snapshot[`head:${id}@${entry.id}`] = await storage.findLatestHeadMarker(
				id,
				entry.id,
				context,
			);
		}
	}
	const tasks = await scanAll((cursor) => storage.scanTasks({}, 2, cursor, context));
	snapshot.tasks = tasks;
	for (const task of tasks) {
		snapshot[`task:${task.id}`] = await storage.task(task.id, context);
		scopes.push({ kind: 'task', taskId: task.id });
	}
	for (const status of ['pending', 'running', 'waiting', 'completing', 'terminal'] as const) {
		snapshot[`tasks:${status}`] = await scanAll((cursor) =>
			storage.scanTasks({ status }, 2, cursor, context),
		);
	}
	const submissions = await scanAll((cursor) => storage.scanSubmissions({}, 2, cursor, context));
	snapshot.submissions = submissions;
	for (const submission of submissions) {
		snapshot[`submission:${submission.id}`] = await storage.submission(submission.id, context);
		if (submission.requestId !== undefined) {
			snapshot[`request:${submission.conversationId}/${submission.requestId}`] =
				await storage.submissionByRequest(submission.conversationId, submission.requestId, context);
		}
	}
	const points = [
		'current' as const,
		...Array.from({ length: lastSeq }, (_, index) => (index + 1) as Seq),
	];
	for (const scope of scopes) {
		for (const at of points) {
			const documents = await scanAll((cursor) =>
				storage.scanDocuments({ scope: scope as never, at }, 3, cursor, context),
			);
			const key = `${JSON.stringify(scope)}@${at}`;
			snapshot[`docs:${key}`] = documents;
			for (const document of documents) {
				snapshot[`doc:${document.id}@${at}`] = await settle(() =>
					storage.document(document.id, at, context),
				);
				snapshot[`find:${key}/${document.kind}/${document.key ?? ''}`] = await settle(() =>
					storage.findDocument(
						{
							kind: document.kind,
							scope: scope as never,
							...(document.key === undefined ? {} : { key: document.key }),
						},
						at,
						context,
					),
				);
			}
		}
	}
	return snapshot;
}
