/**
 * Live artifacts read gateway Worker (staging/production).
 */

import { LiveArtifactHub } from './artifact-hub-do.ts';

export { LiveArtifactHub };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/health') {
			return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
		}
		if (url.pathname.startsWith('/live-artifacts/')) {
			const id = env.ARTIFACT_HUB.idFromName('primary');
			const stub = env.ARTIFACT_HUB.get(id);
			return stub.fetch(request);
		}
		return new Response(JSON.stringify({ error: 'not found' }), {
			status: 404,
			headers: { 'content-type': 'application/json' },
		});
	},
};
