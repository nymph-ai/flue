/**
 * Pi's classifier pattern in Flue Code Mode, in an agent's Durable Object
 * (`codemode-turn.ts`): one script lists 40 notes from an in-isolate MCP
 * server, classifies each with `models.classify()` from four concurrent
 * workers (`Promise.all`), and stores the results — which a later script,
 * after an eviction, reads back. The classifier is a faux, registered as
 * `faux-jev/jev`; the live run against TypeSafe's Jev and Linear is the
 * society's scenario n.
 */
import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CLASSIFY_SCRIPT, NOTES, notesMcp, toolResults } from './codemode-turn.ts';
import { carol } from './turn-driver.ts';

/** The JSON a completed script's result ends with (Pi's header, then the returned value). */
function returned(text: string | undefined): unknown {
	if (!text?.startsWith('Script completed')) throw new Error(`Not a completed script:\n${text}`);
	return JSON.parse(text.slice(text.indexOf('Output:\n') + 'Output:\n'.length));
}

describe('models.classify() over MCP results in Code Mode (workerd)', () => {
	it('classifies concurrently, and its store() write persists', { timeout: 60_000 }, async () => {
		expect(CLASSIFY_SCRIPT).toContain('Promise.all');
		const { stub, say } = await carol('classify');
		const before = notesMcp.calls.length;
		const seen = toolResults.length;
		await say('Please classify the notes.');
		console.log(`[codemode-classify] ${toolResults[seen]?.split('\n').slice(0, 2).join(' / ')}`);

		const expected = { none: 0, mild: 0, high: 0 };
		for (const note of NOTES) expected[note.tone]++;
		expect(returned(toolResults[seen])).toEqual({ total: 40, counts: expected });
		const calls = notesMcp.calls.slice(before);
		expect(calls.filter((call) => call.name === 'list_notes')).toHaveLength(1);
		expect(calls.filter((call) => call.name === 'get_note')).toHaveLength(40);

		await evictDurableObject(stub);
		await say('Now recall it.');
		expect(returned(toolResults.at(-1))).toBe(40);
	});
});
