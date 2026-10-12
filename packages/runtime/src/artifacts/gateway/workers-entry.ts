/**
 * Test-worker entry for the artifact read gateway (P22-A5).
 * Miniflare hits this through the codemode test worker. The handler never
 * constructs an AgentDO; the wake header on SSE is 0.
 */

import { issueViewerToken } from '../auth/tokens.ts';
import { createArtifactGateway } from './worker.ts';

const SECRET = 'p22-workers-test';
const NOW = 1_700_000_000_000;

const handler = createArtifactGateway({
	secret: SECRET,
	now: () => NOW,
	gateway: {
		async bootstrap(artifactId: string) {
			return {
				snapshot: {
					schemaVersion: 1 as const,
					artifactId,
					readModelRevision: 1,
					state: { home: 1 },
					cursor: '1',
					materializedAt: '2026-10-12T00:00:00.000Z',
				},
				cursor: '1',
			};
		},
		async *follow() {
			yield { eventId: 'e1', type: 'artifact.state.updated' };
		},
	},
});

export async function handleP22(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/p22/token') {
		const artifactId = url.searchParams.get('artifactId') ?? '';
		if (!artifactId) return new Response('missing artifactId', { status: 400 });
		const token = issueViewerToken(SECRET, {
			artifactId,
			tenantId: 't',
			principal: 'user:a',
			tools: [],
			exp: NOW + 60_000,
		});
		return Response.json({ token });
	}
	return handler.fetch(request);
}
