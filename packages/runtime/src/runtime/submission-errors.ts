import { FlueError } from '../errors.ts';

/**
 * The durable-shaped, stackless error projection shared by the settlement
 * record, the live `submission_settled` event, and `submission_recovery`
 * payloads. Non-`FlueError` failures are replaced wholesale — internal
 * messages never ride event or record error fields; the live observation's
 * `errorInfo` detail carries the classified error (with throw-site stack)
 * instead.
 */
export function serializeSubmissionError(error: unknown): {
	name?: string;
	message: string;
	type?: string;
	details?: string;
	dev?: string;
	meta?: Record<string, unknown>;
} {
	if (error instanceof FlueError) {
		return {
			name: error.name,
			message: error.message,
			type: error.type,
			details: error.details,
			...(error.meta ? { meta: error.meta } : {}),
		};
	}
	return {
		name: 'Error',
		message: 'The agent submission failed because of an internal error.',
		type: 'internal_error',
		details:
			'The server encountered an unexpected error while processing the agent submission. ' +
			'When reporting this failure, quote the settlement submissionId — server-side logs carry the same id.',
	};
}
