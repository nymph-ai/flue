/**
 * MCP OAuth end to end, in process: an MCP server that wants a bearer token,
 * an authorization server (RFC 9728 resource metadata, RFC 8414 metadata,
 * dynamic registration, PKCE, refresh, RFC 9207 `iss`), and Flue's
 * authority/broker — the logic the `FlueMcpAuth` Durable Object hosts — over
 * an in-memory store.
 */
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpConnectionCache } from './mcp.ts';
import {
	createMcpOAuthBroker,
	handleMcpOAuthCallback,
	MCP_OAUTH_CALLBACK_PATH,
	McpAuthorizationRequiredError,
	McpOAuthAuthority,
	mcpOAuth,
	memoryStorage,
	setMcpOAuthBroker,
} from './mcp-oauth.ts';
import { getPreparedToolAdapter } from './tool-adapter.ts';

const MCP_URL = 'https://mcp.test/mcp';
const ISSUER = 'https://auth.test';
const REDIRECT = `https://app.test${MCP_OAUTH_CALLBACK_PATH}`;

async function s256(verifier: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
	);
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function world() {
	const counts = { register: 0, authorizationCode: 0, refresh: 0 };
	const codes = new Map<string, { challenge: string; redirectUri: string }>();
	const valid = new Set<string>();
	let tokenSerial = 0;
	const mcp = createMcpHandler(() => {
		const server = new Server(
			{ name: 'secure', version: '1.0.0' },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler('tools/list', (async () => ({
			tools: [{ name: 'whoami', inputSchema: { type: 'object', properties: {} } }],
		})) as never);
		server.setRequestHandler('tools/call', (async () => ({
			content: [{ type: 'text', text: 'alice' }],
		})) as never);
		return server;
	});
	const issue = () => {
		tokenSerial += 1;
		const access = `at-${tokenSerial}`;
		valid.add(access);
		return {
			access_token: access,
			token_type: 'Bearer',
			expires_in: 3600,
			refresh_token: `rt-${tokenSerial}`,
		};
	};
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin === 'https://mcp.test') {
			if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
				return Response.json({ resource: MCP_URL, authorization_servers: [ISSUER] });
			}
			if (url.pathname === '/mcp') {
				const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
				if (!token || !valid.has(token)) {
					return new Response(null, {
						status: 401,
						headers: {
							'www-authenticate':
								'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
						},
					});
				}
				return mcp.fetch(request);
			}
		}
		if (url.origin === ISSUER) {
			if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
				return Response.json({
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/authorize`,
					token_endpoint: `${ISSUER}/token`,
					registration_endpoint: `${ISSUER}/register`,
					response_types_supported: ['code'],
					grant_types_supported: ['authorization_code', 'refresh_token'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['none'],
					authorization_response_iss_parameter_supported: true,
				});
			}
			if (url.pathname === '/register') {
				counts.register += 1;
				const metadata = (await request.json()) as Record<string, unknown>;
				expect(metadata.application_type).toBe('web');
				return Response.json({ ...metadata, client_id: 'client-1' }, { status: 201 });
			}
			if (url.pathname === '/token') {
				const form = new URLSearchParams(await request.text());
				if (form.get('grant_type') === 'authorization_code') {
					const code = codes.get(form.get('code') ?? '');
					if (!code || code.challenge !== (await s256(form.get('code_verifier') ?? ''))) {
						return Response.json({ error: 'invalid_grant' }, { status: 400 });
					}
					counts.authorizationCode += 1;
					return Response.json(issue());
				}
				if (form.get('grant_type') === 'refresh_token') {
					counts.refresh += 1;
					return Response.json(issue());
				}
			}
		}
		return new Response('not found', { status: 404 });
	}) as typeof fetch;
	/** Play the user at the authorization endpoint: approve, and follow the redirect. */
	const approve = (authorizationUrl: string, iss = ISSUER) => {
		const url = new URL(authorizationUrl);
		const code = `code-${codes.size + 1}`;
		codes.set(code, {
			challenge: url.searchParams.get('code_challenge') ?? '',
			redirectUri: url.searchParams.get('redirect_uri') ?? '',
		});
		const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
		callback.searchParams.set('code', code);
		callback.searchParams.set('state', url.searchParams.get('state') ?? '');
		callback.searchParams.set('iss', iss);
		return new Request(callback);
	};
	return { fetch: fetchFn, approve, counts, valid };
}

afterEach(() => setMcpOAuthBroker(undefined));

function whoami(connection: { tools: { name: string }[] }) {
	const adapter = getPreparedToolAdapter(connection.tools[0] as never);
	if (!adapter) throw new Error('expected an MCP tool');
	return adapter.execute({});
}

describe('MCP OAuth', () => {
	it('registers, sends the user to authorize, finishes on the callback, and connects', async () => {
		const env = world();
		setMcpOAuthBroker(createMcpOAuthBroker({ fetch: env.fetch }));
		const definition = {
			name: 'secure',
			url: MCP_URL,
			fetch: env.fetch,
			auth: mcpOAuth({ principal: 'user-1', redirectUrl: REDIRECT }),
		};
		const cache = createMcpConnectionCache();
		const required = await cache.resolve(definition).catch((error: unknown) => error);
		expect(required).toBeInstanceOf(McpAuthorizationRequiredError);
		const authorizationUrl = (required as McpAuthorizationRequiredError).authorizationUrl;
		expect(authorizationUrl.startsWith(`${ISSUER}/authorize`)).toBe(true);
		expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(REDIRECT);
		expect(env.counts.register).toBe(1);

		const page = await handleMcpOAuthCallback(env.approve(authorizationUrl));
		expect(page?.status).toBe(200);
		expect(env.counts.authorizationCode).toBe(1);

		const connection = await cache.resolve(definition);
		expect(await whoami(connection)).toEqual([{ type: 'text', text: 'alice' }]);
		await cache.close();
	});

	it('rejects a callback whose iss names another authorization server (RFC 9207)', async () => {
		const env = world();
		setMcpOAuthBroker(createMcpOAuthBroker({ fetch: env.fetch }));
		const definition = {
			name: 'secure',
			url: MCP_URL,
			fetch: env.fetch,
			auth: mcpOAuth({ principal: 'user-2', redirectUrl: REDIRECT }),
		};
		const cache = createMcpConnectionCache();
		const required = (await cache
			.resolve(definition)
			.catch((error: unknown) => error)) as McpAuthorizationRequiredError;
		const page = await handleMcpOAuthCallback(
			env.approve(required.authorizationUrl, 'https://evil.test'),
		);
		expect(page?.status).toBe(400);
		expect(env.counts.authorizationCode).toBe(0);
		await cache.close();
	});

	it('ignores requests for other paths', async () => {
		expect(await handleMcpOAuthCallback(new Request('https://app.test/agents/x'))).toBeUndefined();
	});

	it('refreshes an expiring token once, however many callers ask at the same time', async () => {
		const env = world();
		const storage = memoryStorage();
		const authority = new McpOAuthAuthority(storage, env.fetch);
		const request = {
			principal: 'user-3',
			issuer: ISSUER,
			serverUrl: MCP_URL,
			oauth: { redirectUrl: REDIRECT },
		};
		// A completed authorization whose token is about to expire.
		await storage.put('client', { client_id: 'client-1', issuer: ISSUER });
		await storage.put(`tokens:${encodeURIComponent(MCP_URL)}`, {
			access_token: 'old',
			token_type: 'Bearer',
			expires_in: 30,
			refresh_token: 'rt-old',
			issuer: ISSUER,
			obtained_at: Date.now(),
		});
		const tokens = await Promise.all([
			authority.token(request),
			authority.token(request),
			authority.token(request),
		]);
		expect(env.counts.refresh).toBe(1);
		expect(new Set(tokens).size).toBe(1);
		expect(tokens[0]).toBe('at-1');
	});
});
