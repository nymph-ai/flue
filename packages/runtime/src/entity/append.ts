import { type DurableStreamLog, DurableStreamLogError } from '../streams/log.ts';

/** Append to `path`, creating the stream first when it does not exist yet (one PUT, once). */
export async function appendCreating(
	log: DurableStreamLog,
	path: string,
	message: unknown,
	signal: AbortSignal | undefined,
): Promise<void> {
	await appendCreatingMany(log, path, [message], signal);
}

/**
 * Append many messages in one POST (P22-A6). One subrequest per stream batch,
 * plus at most one ensure when the stream is missing.
 */
export async function appendCreatingMany(
	log: DurableStreamLog,
	path: string,
	messages: readonly unknown[],
	signal: AbortSignal | undefined,
): Promise<void> {
	if (messages.length === 0) return;
	try {
		await log.append(path, messages, signal);
	} catch (error) {
		if (!(error instanceof DurableStreamLogError) || error.code !== 'not-found') throw error;
		await log.ensure(path, signal);
		await log.append(path, messages, signal);
	}
}
