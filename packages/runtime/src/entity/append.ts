import { type DurableStreamLog, DurableStreamLogError } from '../streams/log.ts';

/** Append to `path`, creating the stream first when it does not exist yet (one PUT, once). */
export async function appendCreating(
	log: DurableStreamLog,
	path: string,
	message: unknown,
	signal: AbortSignal | undefined,
): Promise<void> {
	try {
		await log.append(path, [message], signal);
	} catch (error) {
		if (!(error instanceof DurableStreamLogError) || error.code !== 'not-found') throw error;
		await log.ensure(path, signal);
		await log.append(path, [message], signal);
	}
}
