/**
 * Cloudflare fetch handler for the artifact read gateway (live-artifacts A5).
 *
 * GET /live-artifacts/bootstrap?artifactId=  → JSON snapshot + cursor
 * GET /live-artifacts/stream?artifactId=&cursor= → text/event-stream
 *
 * The handler does not call an AgentDO. Authorization is the viewer token.
 */

import { verifyViewerToken } from '../auth/tokens.ts';
import { ArtifactRevokedError, UnauthorizedError } from './memory-gateway.ts';
import type { ReadGatewayPort } from './read-gateway.ts';

export interface ArtifactGatewayOptions {
	readonly gateway: ReadGatewayPort;
	readonly secret: string;
	readonly now?: () => number;
}

export function createArtifactGateway(options: ArtifactGatewayOptions) {
	return {
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			if (url.pathname === '/health') {
				return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
			}
			const artifactId = url.searchParams.get('artifactId') ?? '';
			const token = bearer(request);
			if (!artifactId || !token) return json({ error: 'UNAUTHORIZED' }, 401);
			const claims = verifyViewerToken(options.secret, token, options.now?.() ?? Date.now());
			if (!claims || claims.artifactId !== artifactId) return json({ error: 'UNAUTHORIZED' }, 401);

			try {
				if (url.pathname === '/live-artifacts/bootstrap') {
					const boot = await options.gateway.bootstrap(artifactId, token);
					return json(boot, 200);
				}
			} catch (error) {
				if (error instanceof UnauthorizedError || error instanceof ArtifactRevokedError) {
					return json({ error: 'UNAUTHORIZED' }, 401);
				}
				throw error;
			}
			if (url.pathname === '/live-artifacts/stream') {
				const cursor = url.searchParams.get('cursor') ?? '';
				if (!cursor) return json({ error: 'cursor required' }, 400);
				const encoder = new TextEncoder();
				let stream: ReadableStream;
				try {
					stream = new ReadableStream({
					async start(controller) {
						try {
							for await (const event of options.gateway.follow(
								artifactId,
								cursor,
								token,
								request.signal,
							)) {
								if (request.signal.aborted) break;
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							}
							controller.close();
						} catch (error) {
							controller.error(error);
						}
					},
				});
				} catch (error) {
					if (error instanceof UnauthorizedError || error instanceof ArtifactRevokedError) {
						return json({ error: 'UNAUTHORIZED' }, 401);
					}
					throw error;
				}
				return new Response(stream, {
					headers: {
						'content-type': 'text/event-stream',
						'cache-control': 'no-cache',
						'x-agentdo-wake': '0',
					},
				});
			}
			return json({ error: 'not found' }, 404);
		},
	};
}

function bearer(request: Request): string | null {
	const header = request.headers.get('authorization') ?? '';
	const match = /^Bearer\s+(.+)$/.exec(header);
	return match?.[1] ?? null;
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
