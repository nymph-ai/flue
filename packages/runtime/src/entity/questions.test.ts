/**
 * Questions to people as entity events (docs/cloudflare-native.md rule 9),
 * hermetic: the scenarios of `questions-test-support.ts` over the in-memory
 * entity log. `questions.electric.test.ts` runs the same scenarios against a
 * real Durable Streams server.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryDurableStreamLog } from '../streams/memory-log.ts';
import { parseFlueAnswer, parseInputAnswered, summarizeQuestion } from './questions.ts';
import { defineQuestionScenarios } from './questions-test-support.ts';

defineQuestionScenarios('the in-memory log', {
	create: async () => new InMemoryDurableStreamLog(),
});

describe('question events', () => {
	it('accepts only well-formed answers', () => {
		expect(parseFlueAnswer({ kind: 'codemode-approval', decision: 'approve' })).toEqual({
			kind: 'codemode-approval',
			decision: 'approve',
		});
		expect(parseFlueAnswer({ kind: 'codemode-approval', decision: 'maybe' })).toBeUndefined();
		expect(parseFlueAnswer({ kind: 'mcp-input', inputResponses: 'yes' })).toBeUndefined();
		expect(
			parseInputAnswered({
				type: 'flue.input-answered',
				eventId: 'e1',
				from: { type: 'person', id: 'pat' },
				questionId: 'q',
				answer: { kind: 'mcp-input', inputResponses: { a: 1 } },
			}),
		).toMatchObject({ questionId: 'q', answer: { kind: 'mcp-input' } });
		expect(
			parseInputAnswered({ type: 'flue.input-answered', eventId: 'e1', questionId: 'q' }),
		).toBeUndefined();
	});

	it('summarizes a question for the person (or agent) answering it', () => {
		expect(
			summarizeQuestion({
				kind: 'codemode-approval',
				id: 'codemode:0:c:0123456789ab',
				executionId: '0:c',
				pending: [{ seq: 0, connector: 'tools', method: 'send_email', args: { to: 'ops' } }],
				conversationId: '0',
				callId: 'c',
			}),
		).toContain('Approve tools.send_email({"to":"ops"})?');
		expect(
			summarizeQuestion({
				kind: 'mcp-input',
				id: 'mcp:ops:x',
				server: 'ops',
				method: 'tools/call',
				params: {},
				inputRequests: {
					confirm: {
						method: 'elicitation/create',
						params: { message: 'Deploy?', requestedSchema: { properties: { approved: {} } } },
					},
				},
			}),
		).toContain('"confirm" elicitation/create: Deploy? (fields: approved)');
	});
});
