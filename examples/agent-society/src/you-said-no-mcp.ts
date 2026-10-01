/**
 * Earendil's "You Said No MCP!" script (2026-09-29,
 * https://earendil.com/posts/you-said-no-mcp/), for the steward's
 * `codemode frustration` command. One line differs from the post: the post
 * reaches Jev through Workers AI (`"cloudflare-workers-ai", "typesafe/jev"`),
 * which this account cannot use without a prepaid balance, so the script
 * names TypeSafe's own endpoint (`"typesafe", "jev-latest"`). The `linear`
 * server is the stand-in on society-ops (`/linear/mcp`).
 */
export const FRUSTRATION_SCRIPT = `const { issues } = await tools.mcp__linear__list_issues({
  team: "Pi", state: "open", limit: 250,
});
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
    const { comments } = await tools.mcp__linear__list_comments({
      issueId: issue.identifier,
    });
    const c = await models.classify(jev, { state: { ...issue, comments }, questions });
    results.push({ id: issue.identifier, title: issue.title, ...c.answers.frustration });
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
