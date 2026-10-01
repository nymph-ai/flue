/**
 * Earendil's "You Said No MCP!" script (2026-09-29,
 * https://earendil.com/posts/you-said-no-mcp/), for the steward's
 * `codemode frustration <team>` command, against the real Linear MCP server
 * (read-only). It differs from the post where Pi itself or this workspace
 * makes it:
 *
 * - Pi resolves an MCP call to its whole `CallToolResult` (0.99.0 and
 *   0.99.2 alike), and Linear declares no output schema and sends no
 *   `structuredContent`, so the `{ issues }` and `{ comments }` are parsed
 *   from the result's text: `JSON.parse((await …).content[0].text)`.
 * - Linear's issues carry their key (`NYM-123`) as `id`; there is no
 *   `identifier` field.
 * - The team is this workspace's (from `list_teams`), the state `started`
 *   (Linear has no `open` state), and the limit 50.
 * - Jev is reached through TypeSafe (`"typesafe", "jev-latest"`): this
 *   account cannot use Workers AI's `typesafe/jev` without a prepaid balance.
 */
export function frustrationScript(team: string): string {
	return `const { issues } = JSON.parse((await tools.mcp__linear__list_issues({
  team: ${JSON.stringify(team)}, state: "started", limit: 50,
})).content[0].text);
const jev = await models.getModelOfType(
  "classifier", "typesafe", "jev-latest",
);
const questions = {
  frustration: {
    type: "choice",
    instructions: "Judge ONLY the emotional tone of the people writing. " +
      "Ignore how severe the bug is.",
    criteria: {
      none: "Neutral, factual, or friendly, even about a serious bug",
      mild: "Explicit annoyance, impatience, or disappointment",
      high: "Clearly angry, exasperated, sarcastic, or fed up",
    },
  },
};

const results = [];
let next = 0;
async function worker() {
  while (next < issues.length) {
    const issue = issues[next++];
    const { comments } = JSON.parse((await tools.mcp__linear__list_comments({
      issueId: issue.id,
    })).content[0].text);
    const c = await models.classify(jev, { state: { ...issue, comments }, questions });
    results.push({ id: issue.id, title: issue.title, ...c.answers.frustration });
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
store("frustration", results);

const score = (r) => r.probabilities.mild * 0.5 + r.probabilities.high;
const counts = {};
for (const r of results) counts[r.choice] = (counts[r.choice] ?? 0) + 1;
const flagged = results.filter((r) => r.choice !== "none");
flagged.sort((a, b) => score(b) - score(a));
return {
  total: results.length,
  counts,
  flagged: flagged.map((r) => \`\${r.id} \${r.title}\`),
};`;
}
