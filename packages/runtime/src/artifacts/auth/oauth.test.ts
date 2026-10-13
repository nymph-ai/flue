import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	authorizationUrl,
	createPkcePair,
	exchangeAuthorizationCode,
	OAuthDisabledError,
	type OAuthProviderConfig,
} from './oauth.ts';

const config: OAuthProviderConfig = {
	enabled: true,
	issuer: 'https://idp.example',
	clientId: 'live-artifacts-client',
	clientSecret: 'live-artifacts-secret',
	redirectUri: 'https://app.example/callback',
	scopes: ['artifact:read'],
};

describe('OAuth PKCE client', () => {
	it('builds an S256 authorize URL and exchanges a code with a mock IdP', async () => {
		const pkce = createPkcePair();
		expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
		const url = new URL(authorizationUrl(config, 'state-1', pkce));
		expect(url.origin).toBe('https://idp.example');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBe('state-1');

		let seenVerifier = '';
		const fetchImpl: typeof fetch = async (_input, init) => {
			const params = new URLSearchParams(String(init?.body ?? ''));
			seenVerifier = params.get('code_verifier') ?? '';
			expect(params.get('client_secret')).toBe('live-artifacts-secret');
			expect(params.get('code')).toBe('auth-code');
			if (seenVerifier !== pkce.verifier) {
				return new Response('bad verifier', { status: 400 });
			}
			return Response.json({ access_token: 'tok-1', token_type: 'Bearer' });
		};

		const tokens = await exchangeAuthorizationCode(
			config,
			{ code: 'auth-code', verifier: pkce.verifier },
			fetchImpl,
		);
		expect(tokens).toEqual({ accessToken: 'tok-1', tokenType: 'Bearer' });
		expect(seenVerifier).toBe(pkce.verifier);
	});

	it('does not call fetch when the provider is disabled', async () => {
		let called = false;
		const fetchImpl: typeof fetch = async () => {
			called = true;
			return new Response('nope', { status: 500 });
		};
		await expect(
			exchangeAuthorizationCode({ ...config, enabled: false }, { code: 'x', verifier: 'y' }, fetchImpl),
		).rejects.toBeInstanceOf(OAuthDisabledError);
		expect(called).toBe(false);
	});
});
