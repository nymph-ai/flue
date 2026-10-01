/**
 * The MCP OAuth store on Cloudflare: the `FlueMcpAuth` Durable Object
 * (docs/cloudflare-native.md rule 6). One object per (principal,
 * authorization-server issuer) holds that principal's client registration,
 * tokens, PKCE verifiers and discovery state in its own storage, and runs
 * every flow through one {@link McpOAuthAuthority}, so a refresh is never
 * raced by another agent holding the same refresh token.
 *
 * The generated Worker exports the class (`createFlueMcpAuthClass` over
 * `DurableObject`), binds it as {@link MCP_AUTH_BINDING} when an agent module
 * calls `mcpOAuth(...)`, and installs the broker with
 * {@link installCloudflareMcpOAuth}. Agents reach it over Durable Object RPC.
 */
import {
	type McpOAuthBroker,
	type McpOAuthCallback,
	McpOAuthAuthority,
	type McpOAuthOutcome,
	type McpOAuthRequest,
	type McpOAuthStorage,
	setMcpOAuthBroker,
} from '../mcp-oauth.ts';

/** The binding name of the `FlueMcpAuth` Durable Object namespace. */
export const MCP_AUTH_BINDING = 'FLUE_MCP_AUTH';
/** The class name the generated Worker exports. */
export const MCP_AUTH_CLASS_NAME = 'FlueMcpAuth';

interface DurableObjectStorageLike {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
}

interface McpAuthStub {
	token(request: McpOAuthRequest): Promise<string | undefined>;
	authorize(request: McpOAuthRequest): Promise<McpOAuthOutcome>;
	complete(callback: McpOAuthCallback): Promise<void>;
}

interface McpAuthNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): McpAuthStub;
}

type DurableObjectBase = new (ctx: any, env: any) => object;

/**
 * Build the `FlueMcpAuth` class over the Workers `DurableObject` base (the
 * generated entry passes it in, keeping `cloudflare:workers` out of this
 * module).
 */
export function createFlueMcpAuthClass(
	Base: DurableObjectBase,
): new (ctx: { storage: DurableObjectStorageLike }, env: unknown) => McpAuthStub {
	return class FlueMcpAuth extends Base {
		readonly #authority: McpOAuthAuthority;
		/** Which (principal, issuer) this object serves, fixed by its first request. */
		readonly #storage: DurableObjectStorageLike;

		constructor(ctx: { storage: DurableObjectStorageLike }, env: unknown) {
			super(ctx, env);
			this.#storage = ctx.storage;
			const storage: McpOAuthStorage = {
				get: (key) => ctx.storage.get(key),
				put: (key, value) => ctx.storage.put(key, value),
				delete: async (key) => {
					await ctx.storage.delete(key);
				},
			};
			this.#authority = new McpOAuthAuthority(storage);
		}

		async #bind(principal: string, issuer: string): Promise<void> {
			const identity = JSON.stringify([principal, issuer]);
			const bound = await this.#storage.get<string>('identity');
			if (bound === undefined) await this.#storage.put('identity', identity);
			else if (bound !== identity) {
				throw new Error(
					'[flue] This FlueMcpAuth object serves another principal or authorization server.',
				);
			}
		}

		async token(request: McpOAuthRequest): Promise<string | undefined> {
			await this.#bind(request.principal, request.issuer);
			return this.#authority.token(request);
		}

		async authorize(request: McpOAuthRequest): Promise<McpOAuthOutcome> {
			await this.#bind(request.principal, request.issuer);
			return this.#authority.authorize(request);
		}

		async complete(callback: McpOAuthCallback): Promise<void> {
			await this.#bind(callback.principal, callback.issuer);
			return this.#authority.complete(callback);
		}
	};
}

/** The broker that sends every credential question to its `FlueMcpAuth` object. */
export function durableObjectMcpOAuthBroker(namespace: McpAuthNamespace): McpOAuthBroker {
	const stub = (principal: string, issuer: string) =>
		namespace.get(namespace.idFromName(JSON.stringify([principal, issuer])));
	return {
		token: (request) => stub(request.principal, request.issuer).token(request),
		authorize: (request) => stub(request.principal, request.issuer).authorize(request),
		complete: (callback) => stub(callback.principal, callback.issuer).complete(callback),
	};
}

/**
 * Point MCP OAuth at the `FlueMcpAuth` namespace. Without the binding, OAuth
 * fails with a clear error instead of keeping credentials in isolate memory,
 * which a Worker loses on every eviction.
 */
export function installCloudflareMcpOAuth(env: Record<string, unknown> | undefined): void {
	const namespace = env?.[MCP_AUTH_BINDING] as McpAuthNamespace | undefined;
	if (namespace && typeof namespace.idFromName === 'function') {
		setMcpOAuthBroker(durableObjectMcpOAuthBroker(namespace));
		return;
	}
	const missing = async (): Promise<never> => {
		throw new Error(
			`[flue] MCP OAuth on Cloudflare needs the ${MCP_AUTH_BINDING} Durable Object binding (class ${MCP_AUTH_CLASS_NAME}). ` +
				`@flue/vite adds it when an agent module calls mcpOAuth(...); add "${MCP_AUTH_CLASS_NAME}" to a migration's new_sqlite_classes in wrangler.jsonc.`,
		);
	};
	setMcpOAuthBroker({ token: missing, authorize: missing, complete: missing });
}
