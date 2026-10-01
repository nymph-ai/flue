/**
 * Earendil's "You Said No MCP!" script (`you-said-no-mcp.ts`), unmodified, as
 * the model's `codemode` call in an agent's Durable Object
 * (`codemode-turn.ts`): it reads a 40-issue tracker from an in-isolate MCP
 * server named `linear`, classifies every issue's comments with a faux Jev
 * registered as `cloudflare-workers-ai/typesafe/jev` from four concurrent
 * workers, and stores its results — which a later script, after an eviction,
 * reads back.
 */
import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { linear, toolResults } from './codemode-turn.ts';
import { carol } from './turn-driver.ts';

/** The JSON a completed script's result ends with (Pi's header, then the returned value). */
function returned(text: string | undefined): unknown {
	if (!text?.startsWith('Script completed')) throw new Error(`Not a completed script:\n${text}`);
	return JSON.parse(text.slice(text.indexOf('Output:\n') + 'Output:\n'.length));
}

describe('"You Said No MCP!" on Flue Code Mode (workerd)', () => {
	it(
		"runs the post's script unmodified, and its store() write persists",
		{ timeout: 60_000 },
		async () => {
			const { stub, say } = await carol('frustration');
			const before = linear.calls.length;
			const seen = toolResults.length;
			await say('Measure the frustration in the tracker.');

			const result = returned(toolResults[seen]) as {
				total: number;
				counts: Record<string, number>;
				flagged: string[];
			};
			const { issues, tones } = linear.tracker;
			const expected = { none: 0, mild: 0, high: 0 };
			for (const issue of issues) expected[tones.get(issue.identifier) ?? 'none']++;
			expect(result.total).toBe(40);
			expect(result.counts).toEqual(expected);
			// Highly frustrated first (score mild/2 + high), then the mild ones.
			const flagged = (tone: string) =>
				issues
					.filter((issue) => tones.get(issue.identifier) === tone)
					.map((issue) => `${issue.identifier} ${issue.title}`);
			expect(result.flagged.slice(0, expected.high).sort()).toEqual(flagged('high').sort());
			expect(result.flagged.slice(expected.high).sort()).toEqual(flagged('mild').sort());
			// One list_issues and one list_comments per issue, through the MCP client.
			const calls = linear.calls.slice(before);
			expect(calls.filter((call) => call.name === 'list_issues')).toEqual([
				{ name: 'list_issues', arguments: { team: 'Pi', state: 'open', limit: 250 } },
			]);
			expect(calls.filter((call) => call.name === 'list_comments')).toHaveLength(40);

			// The store() write is a Pi document of the conversation: it survives an eviction.
			await evictDurableObject(stub);
			await say('Now recall it.');
			expect(returned(toolResults[seen + 1])).toBe(40);
		},
	);
});
