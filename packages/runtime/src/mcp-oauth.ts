/**
 * OAuth for MCP servers (docs/cloudflare-native.md rule 6).
 *
 * Two halves:
 *
 * - {@link McpOAuthAuthority}: the SDK's `OAuthClientProvider` over a small
 *   key-value store, for ONE principal at ONE authorization server (named by
 *   its issuer). It holds the client registration, the tokens per MCP server,
 *   the PKCE verifiers of authorizations in flight and the discovery state,
 *   and runs every flow — refresh included — one at a time. On Cloudflare it
 *   lives in the `FlueMcpAuth` Durable Object (one object per principal and
 *   issuer, so refreshes from many agents serialize in one place); on Node in
 *   process memory, or wherever an application's {@link McpOAuthStorage}
 *   puts it.
 * - The client side ({@link createMcpAuthProvider}): what the MCP transport
 *   calls. It discovers the server's authorization server, asks the broker
 *   for the current access token before every request, and on a 401 asks
 *   for a refresh. When only the user can help, the call fails with
 *   {@link McpAuthorizationRequiredError}, which carries the authorization
 *   URL to send the user to. The redirect lands on Flue's callback route,
 *   {@link MCP_OAUTH_CALLBACK_PATH}, which finishes the flow.
 *
 * The MCP 2026-07-28 rules are the SDK's, and this module feeds them: the
 * RFC 9207 `iss` check on the callback (the route passes `iss` through), the
 * issuer stamp on stored credentials and the callback-leg issuer binding
 * (SEP-2352; discovery state is persisted with the verifier), Client ID
 * Metadata Documents when the server advertises them, and
 * `application_type` in dynamic registration.
 */
import {
	type AuthProvider,
	auth,
	discoverOAuthServerInfo,
	type FetchLike,
	type OAuthClientInformationContext,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { isMcpOAuth, type McpAuth, type McpOAuth } from './mcp-types.ts';

/** The route Flue serves for OAuth redirects, on the Gateway Worker and on Node. */
export const MCP_OAUTH_CALLBACK_PATH = '/__flue/mcp/oauth/callback';

/** Refresh this long before a token's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;
/** Authorizations in flight older than this are forgotten. */
const PENDING_TTL_MS = 60 * 60 * 1000;

/** Build an {@link McpOAuth} declaration for `useMcpConnection({ auth })`. */
export function mcpOAuth(options: Omit<McpOAuth, 'type'>): McpOAuth {
	if (!options || typeof options.principal !== 'string' || options.principal.length === 0) {
		throw new Error('[flue] mcpOAuth() requires `principal`: whose credentials these are.');
	}
	if (typeof options.redirectUrl !== 'string' || !URL.canParse(options.redirectUrl)) {
		throw new Error(
			`[flue] mcpOAuth() requires \`redirectUrl\`: the absolute URL of Flue's callback route (https://<your app>${MCP_OAUTH_CALLBACK_PATH}).`,
		);
	}
	return Object.freeze({ ...options, type: 'oauth' as const });
}

/** The user must authorize the agent at {@link authorizationUrl} before the server can be used. */
export class McpAuthorizationRequiredError extends Error {
	override readonly name = 'McpAuthorizationRequiredError';
	constructor(
		readonly server: string,
		readonly authorizationUrl: string,
	) {
		super(
			`[flue] MCP server "${server}" needs authorization. Open ${authorizationUrl} to grant access, then retry.`,
		);
	}
}

/** Key-value storage for one principal at one authorization server. */
export interface McpOAuthStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
}

/** One credential question about one MCP server, as the client side asks it. */
export interface McpOAuthRequest {
	readonly principal: string;
	/** The authorization server's issuer: which store answers. */
	readonly issuer: string;
	/** The MCP server (the protected resource). */
	readonly serverUrl: string;
	readonly oauth: Omit<McpOAuth, 'type' | 'principal'>;
}

/** The outcome of running the flow: done, or the user has to go to a URL. */
export type McpOAuthOutcome =
	| { readonly status: 'authorized' }
	| { readonly status: 'redirect'; readonly authorizationUrl: string };

/** The callback parameters the authorization server sent back. */
export interface McpOAuthCallback {
	readonly principal: string;
	readonly issuer: string;
	readonly nonce: string;
	readonly code: string;
	readonly iss?: string;
}

/** Where the client side takes its credential questions. */
export interface McpOAuthBroker {
	/** The current access token, refreshed when it is about to expire; undefined when there is none. */
	token(request: McpOAuthRequest): Promise<string | undefined>;
	/** Refresh, or start an authorization: after a 401. */
	authorize(request: McpOAuthRequest): Promise<McpOAuthOutcome>;
	/** Finish an authorization from its callback. */
	complete(callback: McpOAuthCallback): Promise<void>;
}

type StoredTokens = StoredOAuthTokens & { obtained_at?: number };
type Pending = {
	serverUrl: string;
	verifier?: string;
	createdAt: number;
	oauth: McpOAuthRequest['oauth'];
};

const enc = (value: string) => encodeURIComponent(value);

/**
 * The SDK's OAuth client provider over one store, for one MCP server. Built
 * per flow: `state()` mints the flow's nonce, and the callback leg is built
 * with the nonce it came back with.
 */
class StoredOAuthProvider implements OAuthClientProvider {
	authorizationUrl: string | undefined;
	readonly #storage: McpOAuthStorage;
	readonly #request: McpOAuthRequest;
	readonly #nonce: string;

	constructor(storage: McpOAuthStorage, request: McpOAuthRequest, nonce?: string) {
		this.#storage = storage;
		this.#request = request;
		this.#nonce = nonce ?? crypto.randomUUID();
		if (request.oauth.clientMetadataUrl) this.clientMetadataUrl = request.oauth.clientMetadataUrl;
	}

	clientMetadataUrl?: string;

	get redirectUrl(): string {
		return this.#request.oauth.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: this.#request.oauth.clientName ?? 'Flue',
			redirect_uris: [this.#request.oauth.redirectUrl],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			// MCP 2026-07-28: clients state their application type when registering.
			application_type: 'web',
			...(this.#request.oauth.scope ? { scope: this.#request.oauth.scope } : {}),
		};
	}

	state(): string {
		return encodeState(this.#request.principal, this.#request.issuer, this.#nonce);
	}

	clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
		return this.#storage.get('client');
	}

	async saveClientInformation(information: StoredOAuthClientInformation): Promise<void> {
		await this.#storage.put('client', information);
	}

	tokens(_ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
		return this.#storage.get(`tokens:${enc(this.#request.serverUrl)}`);
	}

	async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
		await this.#storage.put(`tokens:${enc(this.#request.serverUrl)}`, {
			...tokens,
			obtained_at: Date.now(),
		} satisfies StoredTokens);
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this.authorizationUrl = authorizationUrl.href;
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.#storage.put(`pending:${this.#nonce}`, {
			serverUrl: this.#request.serverUrl,
			verifier: codeVerifier,
			createdAt: Date.now(),
			oauth: this.#request.oauth,
		} satisfies Pending);
		await rememberPending(this.#storage, this.#nonce);
	}

	async codeVerifier(): Promise<string> {
		const pending = await this.#storage.get<Pending>(`pending:${this.#nonce}`);
		if (!pending?.verifier) throw new Error('[flue] No authorization in flight for this callback.');
		return pending.verifier;
	}

	saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		return this.#storage.put(`discovery:${enc(this.#request.serverUrl)}`, state);
	}

	discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return this.#storage.get(`discovery:${enc(this.#request.serverUrl)}`);
	}

	async invalidateCredentials(
		scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
	): Promise<void> {
		const server = enc(this.#request.serverUrl);
		if (scope === 'all' || scope === 'client') await this.#storage.delete('client');
		if (scope === 'all' || scope === 'tokens') await this.#storage.delete(`tokens:${server}`);
		if (scope === 'all' || scope === 'verifier')
			await this.#storage.delete(`pending:${this.#nonce}`);
		if (scope === 'all' || scope === 'discovery') await this.#storage.delete(`discovery:${server}`);
	}
}

/** Keep an index of the flows in flight so stale verifiers are dropped. */
async function rememberPending(storage: McpOAuthStorage, nonce: string): Promise<void> {
	const now = Date.now();
	const index = (await storage.get<Record<string, number>>('pending')) ?? {};
	for (const [key, createdAt] of Object.entries(index)) {
		if (now - createdAt > PENDING_TTL_MS) {
			delete index[key];
			await storage.delete(`pending:${key}`);
		}
	}
	index[nonce] = now;
	await storage.put('pending', index);
}

/**
 * Every OAuth flow for one principal at one authorization server, run one at
 * a time over its storage. Hosted by the `FlueMcpAuth` Durable Object on
 * Cloudflare and by {@link createMcpOAuthBroker} elsewhere.
 */
export class McpOAuthAuthority {
	#tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly storage: McpOAuthStorage,
		private readonly fetchFn?: FetchLike,
	) {}

	#exclusive<T>(run: () => Promise<T>): Promise<T> {
		const next = this.#tail.then(run, run);
		this.#tail = next.catch(() => undefined);
		return next;
	}

	/** The stored access token, refreshed first when it is about to expire. */
	token(request: McpOAuthRequest): Promise<string | undefined> {
		return this.#exclusive(async () => {
			const provider = new StoredOAuthProvider(this.storage, request);
			const tokens = (await provider.tokens()) as StoredTokens | undefined;
			if (!tokens) return undefined;
			if (!isExpiring(tokens)) return tokens.access_token;
			if (!tokens.refresh_token) return undefined;
			const outcome = await auth(provider, this.#options(request));
			if (outcome !== 'AUTHORIZED') return undefined;
			return ((await provider.tokens()) as StoredTokens | undefined)?.access_token;
		});
	}

	/** Refresh, or start an authorization whose URL the user must open. */
	authorize(request: McpOAuthRequest): Promise<McpOAuthOutcome> {
		return this.#exclusive(async () => {
			const provider = new StoredOAuthProvider(this.storage, request);
			const outcome = await auth(provider, this.#options(request));
			if (outcome === 'AUTHORIZED') return { status: 'authorized' };
			if (!provider.authorizationUrl)
				throw new Error('[flue] OAuth flow ended without an authorization URL.');
			return { status: 'redirect', authorizationUrl: provider.authorizationUrl };
		});
	}

	/** Finish an authorization: validate `iss`, redeem the code, store the tokens. */
	complete(callback: McpOAuthCallback): Promise<void> {
		return this.#exclusive(async () => {
			const pending = await this.storage.get<Pending>(`pending:${callback.nonce}`);
			if (!pending) throw new Error('[flue] Unknown or expired OAuth authorization.');
			const request: McpOAuthRequest = {
				principal: callback.principal,
				issuer: callback.issuer,
				serverUrl: pending.serverUrl,
				oauth: pending.oauth,
			};
			const provider = new StoredOAuthProvider(this.storage, request, callback.nonce);
			try {
				await auth(provider, {
					...this.#options(request),
					authorizationCode: callback.code,
					...(callback.iss !== undefined ? { iss: callback.iss } : {}),
				});
			} finally {
				await this.storage.delete(`pending:${callback.nonce}`);
			}
		});
	}

	#options(request: McpOAuthRequest) {
		return {
			serverUrl: request.serverUrl,
			...(request.oauth.scope ? { scope: request.oauth.scope } : {}),
			...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
		};
	}
}

function isExpiring(tokens: StoredTokens): boolean {
	if (typeof tokens.expires_in !== 'number' || typeof tokens.obtained_at !== 'number') return false;
	return Date.now() >= tokens.obtained_at + tokens.expires_in * 1000 - EXPIRY_MARGIN_MS;
}

/**
 * A broker over {@link McpOAuthAuthority} instances held in this process —
 * the Node default. `storage` places each principal's store; the default
 * keeps it in memory, so authorizations last as long as the process.
 */
export function createMcpOAuthBroker(
	options: {
		readonly storage?: (principal: string, issuer: string) => McpOAuthStorage;
		readonly fetch?: FetchLike;
	} = {},
): McpOAuthBroker {
	const authorities = new Map<string, McpOAuthAuthority>();
	const authority = (principal: string, issuer: string) => {
		const key = JSON.stringify([principal, issuer]);
		let found = authorities.get(key);
		if (!found) {
			found = new McpOAuthAuthority(
				options.storage?.(principal, issuer) ?? memoryStorage(),
				options.fetch,
			);
			authorities.set(key, found);
		}
		return found;
	};
	return {
		token: (request) => authority(request.principal, request.issuer).token(request),
		authorize: (request) => authority(request.principal, request.issuer).authorize(request),
		complete: (callback) => authority(callback.principal, callback.issuer).complete(callback),
	};
}

/** A {@link McpOAuthStorage} in a Map. */
export function memoryStorage(): McpOAuthStorage {
	const values = new Map<string, string>();
	return {
		async get<T>(key: string) {
			const value = values.get(key);
			return value === undefined ? undefined : (JSON.parse(value) as T);
		},
		async put(key, value) {
			values.set(key, JSON.stringify(value));
		},
		async delete(key) {
			values.delete(key);
		},
	};
}

let broker: McpOAuthBroker | undefined;

/**
 * Choose where OAuth credentials live. Cloudflare installs the `FlueMcpAuth`
 * Durable Object broker itself; on Node the default is an in-process store,
 * and an application can pass `createMcpOAuthBroker({ storage })` to keep
 * credentials elsewhere.
 */
export function setMcpOAuthBroker(next: McpOAuthBroker | undefined): void {
	broker = next;
}

function currentBroker(): McpOAuthBroker {
	broker ??= createMcpOAuthBroker();
	return broker;
}

/**
 * The transport's credential source for one server: a static bearer token,
 * a per-request resolver, or the OAuth broker. The transport calls `token()`
 * before every request; on a 401 it awaits `onUnauthorized` and retries once.
 */
export function createMcpAuthProvider(
	serverName: string,
	serverUrl: URL,
	credential: McpAuth,
	fetchFn?: FetchLike,
): AuthProvider {
	if (!isMcpOAuth(credential)) {
		const resolveToken = typeof credential === 'function' ? credential : () => credential;
		// The application's credential store is the refresh policy: the retry
		// after a 401 re-resolves the token.
		return { token: async () => resolveToken(), onUnauthorized: async () => {} };
	}
	const { type: _type, principal, ...oauth } = credential;
	let issuer: Promise<string> | undefined;
	const request = async (): Promise<McpOAuthRequest> => {
		issuer ??= discoverIssuer(serverUrl, fetchFn);
		issuer.catch(() => {
			issuer = undefined;
		});
		return { principal, issuer: await issuer, serverUrl: serverUrl.href, oauth };
	};
	return {
		token: async () => currentBroker().token(await request()),
		onUnauthorized: async () => {
			const outcome = await currentBroker().authorize(await request());
			if (outcome.status === 'redirect') {
				throw new McpAuthorizationRequiredError(serverName, outcome.authorizationUrl);
			}
		},
	};
}

async function discoverIssuer(serverUrl: URL, fetchFn: FetchLike | undefined): Promise<string> {
	const info = await discoverOAuthServerInfo(serverUrl, fetchFn ? { fetchFn } : {});
	return info.authorizationServerMetadata?.issuer ?? info.authorizationServerUrl;
}

function encodeState(principal: string, issuer: string, nonce: string): string {
	const payload = new TextEncoder().encode(JSON.stringify([principal, issuer]));
	let binary = '';
	for (const byte of payload) binary += String.fromCharCode(byte);
	const base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	return `${base64}.${nonce}`;
}

function decodeState(
	state: string,
): { principal: string; issuer: string; nonce: string } | undefined {
	const dot = state.lastIndexOf('.');
	if (dot <= 0) return undefined;
	try {
		const base64 = state.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(base64);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const [principal, issuer] = JSON.parse(new TextDecoder().decode(bytes)) as unknown[];
		if (typeof principal !== 'string' || typeof issuer !== 'string') return undefined;
		return { principal, issuer, nonce: state.slice(dot + 1) };
	} catch {
		return undefined;
	}
}

/**
 * Serve Flue's OAuth callback route; `undefined` for any other request.
 * Mounted ahead of the application by the generated Worker and the Node
 * server. The authorization server's `iss` is handed to the SDK, which
 * rejects a response from an issuer other than the one the flow began with
 * (RFC 9207).
 */
export async function handleMcpOAuthCallback(request: Request): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== MCP_OAUTH_CALLBACK_PATH || request.method !== 'GET') return undefined;
	const page = (status: number, message: string) =>
		new Response(`<!doctype html><title>Flue</title><p>${escapeHtml(message)}</p>`, {
			status,
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
		});
	const error = url.searchParams.get('error');
	if (error) {
		return page(
			400,
			`Authorization was not granted: ${url.searchParams.get('error_description') ?? error}.`,
		);
	}
	const code = url.searchParams.get('code');
	const state = decodeState(url.searchParams.get('state') ?? '');
	if (!code || !state) return page(400, 'This authorization response is incomplete.');
	const iss = url.searchParams.get('iss');
	try {
		await currentBroker().complete({ ...state, code, ...(iss !== null ? { iss } : {}) });
	} catch (cause) {
		return page(
			400,
			`Authorization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	return page(200, 'Authorized. You can close this window and retry the request.');
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
