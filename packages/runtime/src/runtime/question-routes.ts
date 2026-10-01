/**
 * The HTTP surface of an agent instance's questions (docs/cloudflare-native.md
 * rule 9), shared by the Node runtime and the Cloudflare Durable Object:
 *
 * - `GET  /:id/questions` — the questions the instance waits on;
 * - `POST /:id/questions/:questionId/answer` — answer one, with a body
 *   `{ "answer": FlueAnswer, "answerId"?: string, "from"?: { type, id } }`.
 *
 * An answer is appended to the instance's inbox as an `input-answered`
 * event — the path every participant's answer takes — and the instance's
 * doorbell is rung. `answerId` makes a retried request idempotent.
 */
import { parseFlueAnswer } from '../entity/questions.ts';
import { InvalidRequestError } from '../errors.ts';
import type { PendingQuestion } from '../pi/questions.ts';
import type { FlueAnswer } from '../questions.ts';

/** A parsed answer request. */
export interface AnswerRequest {
	readonly answer: FlueAnswer;
	readonly answerId?: string;
	readonly from?: { readonly type: string; readonly id: string };
}

/** What answering returned (`FlueAgentInstance.answerQuestion`). */
export type AnswerResult =
	| { readonly status: 'accepted'; readonly eventId: string }
	| { readonly status: 'unknown' }
	| { readonly status: 'settled'; readonly questionStatus: string }
	| { readonly status: 'mismatched'; readonly expected: string };

/** Parse the body of an answer request; throws {@link InvalidRequestError}. */
export async function parseAnswerRequest(request: Request): Promise<AnswerRequest> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new InvalidRequestError({ reason: 'An answer needs a JSON body: { "answer": … }.' });
	}
	const record = (body ?? {}) as Record<string, unknown>;
	const answer = parseFlueAnswer(record.answer);
	if (!answer) {
		throw new InvalidRequestError({
			reason:
				'`answer` must be {"kind":"codemode-approval","decision":"approve"|"reject","reason"?} or {"kind":"mcp-input","inputResponses":{…}}.',
		});
	}
	const from = record.from as { type?: unknown; id?: unknown } | undefined;
	if (
		from !== undefined &&
		(typeof from !== 'object' ||
			from === null ||
			typeof from.type !== 'string' ||
			!from.type ||
			typeof from.id !== 'string' ||
			!from.id)
	) {
		throw new InvalidRequestError({ reason: '`from` must be { type, id } with non-empty strings.' });
	}
	if (record.answerId !== undefined && (typeof record.answerId !== 'string' || !record.answerId)) {
		throw new InvalidRequestError({ reason: '`answerId` must be a non-empty string.' });
	}
	return {
		answer,
		...(typeof record.answerId === 'string' ? { answerId: record.answerId } : {}),
		...(from ? { from: { type: from.type as string, id: from.id as string } } : {}),
	};
}

/** The response to an answer request. */
export function answerResponse(questionId: string, result: AnswerResult): Response {
	switch (result.status) {
		case 'accepted':
			return Response.json({ questionId, accepted: true, eventId: result.eventId }, { status: 202 });
		case 'unknown':
			return Response.json(
				{ questionId, accepted: false, error: 'No such question.' },
				{ status: 404 },
			);
		case 'settled':
			return Response.json(
				{
					questionId,
					accepted: false,
					status: result.questionStatus,
					error: `The question is already ${result.questionStatus}.`,
				},
				{ status: 409 },
			);
		case 'mismatched':
			return Response.json(
				{
					questionId,
					accepted: false,
					error: `The question needs a ${result.expected} answer.`,
				},
				{ status: 400 },
			);
	}
}

/** The response listing pending questions. */
export function questionsResponse(questions: readonly PendingQuestion[]): Response {
	return Response.json({ questions });
}

/** `/<prefix>/questions` or `/<prefix>/questions/<id>/answer` tails of a canonical agent path. */
export function matchQuestionPath(
	pathname: string,
	agentName: string,
	instanceId: string,
): { readonly kind: 'list' } | { readonly kind: 'answer'; readonly questionId: string } | undefined {
	const segments = pathname.split('/');
	const n = segments.length;
	const at = (index: number) => {
		try {
			return decodeURIComponent(segments[index] as string);
		} catch {
			return undefined;
		}
	};
	if (n >= 4 && segments[n - 1] === 'questions' && at(n - 2) === instanceId && at(n - 3) === agentName) {
		return { kind: 'list' };
	}
	if (
		n >= 6 &&
		segments[n - 1] === 'answer' &&
		segments[n - 3] === 'questions' &&
		at(n - 4) === instanceId &&
		at(n - 5) === agentName
	) {
		const questionId = at(n - 2);
		return questionId ? { kind: 'answer', questionId } : undefined;
	}
	return undefined;
}
