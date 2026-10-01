/**
 * Golden wire tests (PI_UPGRADE_PLAN.md §7 step 7): every scripted scenario
 * runs on the Pi Durable host, and its public conversation — the history
 * snapshot and the updates stream, exactly as `@flue/sdk` reads them — must
 * equal what the legacy loop produced (`fixtures/*.legacy.json`, recorded
 * before the cutover), modulo ids, timestamps, offsets and positions.
 *
 * Normalization, applied to both sides:
 * - ids (message, submission, turn, conversation) become tokens in order of
 *   first appearance, so the structure they encode (which chunk targets which
 *   message, which settlement answered which) still has to match;
 * - timestamps, durations, offsets and positions are erased;
 * - adjacent `message-delta`s of one message and kind are merged (delta
 *   chunking is a transport detail: the faux provider's token sizes are
 *   random, and Pi commits partials on a 100 ms throttle);
 * - `conversation-reset`s after the first are dropped, and an assistant step
 *   that streamed nothing (`message-started` straight into
 *   `message-completed`) is dropped: both are no-ops for a client, and where
 *   they fall is a property of each loop's commit schedule, not of the wire.
 *
 * `KNOWN_DIFFERENCES` lists, per scenario, the content that changed on
 * purpose; each entry is a documented behaviour change.
 */
import { describe, expect, it } from 'vitest';
import type { AgentConversationSnapshot, ConversationStreamChunk } from '../conversation-public.ts';
import { init } from '../index.ts';
import { start } from '../node/index.ts';
import { getFlueRuntime } from '../runtime/flue-app.ts';
import abort from './fixtures/abort.legacy.json' with { type: 'json' };
import compaction from './fixtures/compaction.legacy.json' with { type: 'json' };
import dataAndMetadata from './fixtures/data-and-metadata.legacy.json' with { type: 'json' };
import joinSteer from './fixtures/join-steer.legacy.json' with { type: 'json' };
import plainAnswer from './fixtures/plain-answer.legacy.json' with { type: 'json' };
import signalDelivery from './fixtures/signal-delivery.legacy.json' with { type: 'json' };
import streamedDeltas from './fixtures/streamed-deltas.legacy.json' with { type: 'json' };
import structuredResult from './fixtures/structured-result.legacy.json' with { type: 'json' };
import toolCalls from './fixtures/tool-calls.legacy.json' with { type: 'json' };
import { GOLDEN_SCENARIOS, scenarioProvider } from './scenarios.ts';

interface Fixture {
	scenario: string;
	replies: unknown[];
	history: { status: number; body: unknown };
	updates: unknown[];
}

const fixtures: Record<string, unknown> = {
	abort: abort,
	compaction: compaction,
	'data-and-metadata': dataAndMetadata,
	'join-steer': joinSteer,
	'plain-answer': plainAnswer,
	'signal-delivery': signalDelivery,
	'streamed-deltas': streamedDeltas,
	'structured-result': structuredResult,
	'tool-calls': toolCalls,
};

function fixtureOf(name: string): Fixture {
	const fixture = fixtures[name] as Fixture | undefined;
	if (!fixture) throw new Error(`missing legacy fixture for ${name}`);
	return fixture;
}

const ID_FIELDS = new Set([
	'id',
	'messageId',
	'submissionId',
	'answeredBySubmissionId',
	'conversationId',
	'turnId',
]);
const ERASED_FIELDS = new Set(['timestamp', 'offset', 'incarnation', 'position', 'durationMs']);

/** Content the Pi host changed on purpose, per scenario (see the report's behaviour changes). */
const KNOWN_DIFFERENCES: Record<string, (value: unknown, key: string | undefined) => unknown> = {
	// Pi settles an aborted tool call with its own text.
	abort: (value, key) =>
		key === 'errorText' &&
		(value === 'This operation was aborted' || value === 'Tool block was aborted')
			? '<aborted tool call>'
			: value,
};

function tokenOf(ids: Map<string, string>, id: string): string {
	let token = ids.get(id);
	if (token === undefined) {
		token = `<id${ids.size}>`;
		ids.set(id, token);
	}
	return token;
}

function normalizeValue(
	value: unknown,
	ids: Map<string, string>,
	known: ((value: unknown, key: string | undefined) => unknown) | undefined,
	key?: string,
): unknown {
	const adjusted = known ? known(value, key) : value;
	if (Array.isArray(adjusted)) return adjusted.map((item) => normalizeValue(item, ids, known));
	if (adjusted && typeof adjusted === 'object') {
		const out: Record<string, unknown> = {};
		for (const [field, inner] of Object.entries(adjusted)) {
			if (ERASED_FIELDS.has(field)) continue;
			if (ID_FIELDS.has(field) && typeof inner === 'string') {
				out[field] = tokenOf(ids, inner);
				continue;
			}
			// Submission ids also appear as signal attributes.
			if (field === 'attributes' && inner && typeof inner === 'object') {
				out[field] = Object.fromEntries(
					Object.entries(inner).map(([name, attribute]) => [
						name,
						name === 'submissionId' && typeof attribute === 'string' ? tokenOf(ids, attribute) : attribute,
					]),
				);
				continue;
			}
			out[field] = normalizeValue(inner, ids, known, field);
		}
		return out;
	}
	return adjusted;
}

type Chunk = Record<string, unknown> & { type: string };

function normalizeUpdates(chunks: readonly unknown[]): Chunk[] {
	const out: Chunk[] = [];
	let resets = 0;
	for (const raw of chunks as Chunk[]) {
		if (raw.type === 'stream-checkpoint') continue;
		if (raw.type === 'conversation-reset' && resets++ > 0) continue;
		const last = out.at(-1);
		if (
			raw.type === 'message-delta' &&
			last?.type === 'message-delta' &&
			last.messageId === raw.messageId &&
			last.kind === raw.kind
		) {
			out[out.length - 1] = { ...last, delta: `${String(last.delta)}${String(raw.delta)}` };
			continue;
		}
		if (
			raw.type === 'message-completed' &&
			last?.type === 'message-started' &&
			last.messageId === raw.messageId
		) {
			out.pop();
			continue;
		}
		out.push(raw);
	}
	return out;
}

function normalize(fixture: Omit<Fixture, 'scenario'>, scenario: string) {
	const ids = new Map<string, string>();
	const known = KNOWN_DIFFERENCES[scenario];
	return {
		replies: normalizeValue(fixture.replies, ids, known),
		history: normalizeValue(fixture.history, ids, known),
		updates: normalizeValue(normalizeUpdates(fixture.updates), ids, known),
	};
}

async function readPi(agentName: string, id: string) {
	const runtime = getFlueRuntime();
	if (runtime?.target !== 'node') throw new Error('expected the node runtime');
	const source = await runtime.conversationSource(agentName, id);
	const head = await source.head();
	const snapshot: AgentConversationSnapshot | undefined = head.snapshot
		? { ...head.snapshot, offset: head.offset, incarnation: head.incarnation }
		: undefined;
	const updates: ConversationStreamChunk[] = [];
	let offset = '-1';
	for (let page = 0; page < 100; page++) {
		const read = await source.read(offset);
		if (read === 'aborted') throw new Error('unexpected abort');
		updates.push(...read.chunks);
		if (read.upToDate || read.nextOffset === offset) break;
		offset = read.nextOffset;
	}
	return {
		history: { status: snapshot ? 200 : 404, body: snapshot },
		updates: [{ type: 'stream-checkpoint', incarnation: head.incarnation }, ...updates],
	};
}

describe('golden conversation wire: Pi host vs the legacy loop', () => {
	for (const scenario of GOLDEN_SCENARIOS) {
		it(scenario.name, { timeout: 60_000 }, async () => {
			const legacy = fixtureOf(scenario.name);
			const faux = scenarioProvider(scenario);
			const flue = await start({ agents: [scenario.agent], providers: [faux.provider], env: {} });
			try {
				const id = `golden-${scenario.name}`;
				const handle = init(scenario.agent, { id });
				const run = await scenario.drive(handle);
				const pi = { replies: run.replies, ...(await readPi(scenario.agent.name, id)) };
				expect(normalize(pi, scenario.name)).toEqual(normalize(legacy, scenario.name));
			} finally {
				await flue.stop();
			}
		});
	}
});
