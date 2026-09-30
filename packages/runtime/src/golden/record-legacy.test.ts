/**
 * Records the legacy loop's public conversation wire for every golden
 * scenario (PI_UPGRADE_PLAN.md §7 step 7). Runs only with
 * `FLUE_GOLDEN_RECORD=1`: it prints one `GOLDEN_FIXTURE <name> <base64 json>`
 * line per scenario, which is how the fixtures in `./fixtures/` were taken
 * from the pre-cutover runtime (remote runner; no local build).
 */
import { it } from 'vitest';
import { init } from '../index.ts';
import { start } from '../node/index.ts';
import { getFlueRuntime } from '../runtime/flue-app.ts';
import { handleAgentConversationRead } from '../runtime/handle-conversation-routes.ts';
import { agentStreamPath } from '../runtime/stream-offsets.ts';
import { GOLDEN_SCENARIOS, scenarioProvider } from './scenarios.ts';

const RECORD =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
		?.FLUE_GOLDEN_RECORD === '1';

function base64(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function readRoute(agentName: string, id: string, query: string): Promise<unknown> {
	const runtime = getFlueRuntime();
	if (runtime?.target !== 'node') throw new Error('expected the node runtime');
	const response = await handleAgentConversationRead({
		store: runtime.conversationStreamStore,
		path: agentStreamPath(agentName, id),
		request: new Request(`https://flue.test/agents/${agentName}/${id}?${query}`),
	});
	return { status: response.status, body: await response.json() };
}

async function readAllUpdates(agentName: string, id: string): Promise<unknown[]> {
	const runtime = getFlueRuntime();
	if (runtime?.target !== 'node') throw new Error('expected the node runtime');
	const chunks: unknown[] = [];
	let offset = '-1';
	for (let page = 0; page < 100; page++) {
		const response = await handleAgentConversationRead({
			store: runtime.conversationStreamStore,
			path: agentStreamPath(agentName, id),
			request: new Request(
				`https://flue.test/agents/${agentName}/${id}?view=updates&offset=${encodeURIComponent(offset)}`,
			),
		});
		chunks.push(...((await response.json()) as unknown[]));
		const next = response.headers.get('Stream-Next-Offset') ?? offset;
		if (response.headers.get('Stream-Up-To-Date') === 'true' || next === offset) break;
		offset = next;
	}
	return chunks;
}

for (const scenario of GOLDEN_SCENARIOS) {
	it.runIf(RECORD)(
		`records the legacy wire for ${scenario.name}`,
		{ timeout: 60_000 },
		async () => {
			const faux = scenarioProvider(scenario);
			const flue = await start({ agents: [scenario.agent], providers: [faux.provider], env: {} });
			try {
				const id = `golden-${scenario.name}`;
				const handle = init(scenario.agent, { id });
				const run = await scenario.drive(handle);
				const agentName = scenario.agent.name;
				const fixture = {
					scenario: scenario.name,
					replies: run.replies,
					history: await readRoute(agentName, id, 'view=history'),
					updates: await readAllUpdates(agentName, id),
				};
				const encoded = base64(JSON.stringify(fixture));
				console.log(`GOLDEN_FIXTURE ${scenario.name} ${encoded}`);
			} finally {
				await flue.stop();
			}
		},
	);
}
