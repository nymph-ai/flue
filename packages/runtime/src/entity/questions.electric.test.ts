/**
 * The question scenarios (`questions-test-support.ts`) against a real Durable
 * Streams server: every `input-requested` and `input-answered` event, every
 * inbox read of the pump, crosses HTTP to the server. Doorbells are rung by
 * hand; the webhook path that rings them in production is covered by
 * `a2a.electric.test.ts`.
 *
 * Skipped unless `FLUE_DS_URL` names the server's stream root;
 * `scripts/test-durable-streams-server.sh` runs it.
 */
import { describe } from 'vitest';
import { ElectricDurableStreamLog } from '../streams/electric-log.ts';
import { defineQuestionScenarios } from './questions-test-support.ts';

const env =
	(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const realServer = env.FLUE_DS_URL;

describe.skipIf(!realServer)('against FLUE_DS_URL', () => {
	defineQuestionScenarios('a real Durable Streams server', {
		create: async () => new ElectricDurableStreamLog({ baseUrl: realServer as string }),
	});
});
