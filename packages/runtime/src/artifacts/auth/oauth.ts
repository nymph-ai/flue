/**
 * OAuth authorization-code + PKCE (S256) client (live-artifacts A7).
 *
 * Disabled until `enabled` is set. Tests inject fetch against a mock IdP.
 * No live provider is contacted from this module.
 */

import { createHash, randomBytes } from 'node:crypto';

export class OAuthDisabledError extends Error {
	constructor() {
		super('OAuth provider is disabled');
		this.name = 'OAuthDisabledError';
	}
}

export class OAuthExchangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OAuthExchangeError';
	}
}

export interface OAuthProviderConfig {
	readonly enabled: boolean;
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly redirectUri: string;
	readonly scopes: readonly string[];
}

export interface PkcePair {
	readonly verifier: string;
	readonly challenge: string;
	readonly method: 'S256';
}

export function createPkcePair(): PkcePair {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge, method: 'S256' };
}

export function authorizationUrl(config: OAuthProviderConfig, state: string, pkce: PkcePair): string {
	assertConfigured(config);
	const url = new URL('/oauth/authorize', config.issuer);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('scope', config.scopes.join(' '));
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', pkce.challenge);
	url.searchParams.set('code_challenge_method', pkce.method);
	return url.toString();
}

export async function exchangeAuthorizationCode(
	config: OAuthProviderConfig,
	input: { readonly code: string; readonly verifier: string },
	fetchImpl: typeof fetch = fetch,
): Promise<{ readonly accessToken: string; readonly tokenType: string }> {
	assertConfigured(config);
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code: input.code,
		redirect_uri: config.redirectUri,
		client_id: config.clientId,
		client_secret: config.clientSecret,
		code_verifier: input.verifier,
	});
	const response = await fetchImpl(new URL('/oauth/token', config.issuer), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body,
	});
	if (!response.ok) {
		throw new OAuthExchangeError(`token endpoint returned ${response.status}`);
	}
	const json = (await response.json()) as { access_token?: string; token_type?: string };
	if (!json.access_token || !json.token_type) {
		throw new OAuthExchangeError('token response missing access_token');
	}
	return { accessToken: json.access_token, tokenType: json.token_type };
}

function assertConfigured(config: OAuthProviderConfig): void {
	if (!config.enabled) throw new OAuthDisabledError();
	if (!config.issuer || !config.clientId || !config.clientSecret || !config.redirectUri) {
		throw new OAuthExchangeError('OAuth provider config is incomplete');
	}
}
