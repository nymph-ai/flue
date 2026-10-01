/**
 * What a Code Mode script can reach, and how it finds it.
 *
 * A catalog is a set of namespaces. `tools` holds the agent's own Flue
 * tools, as an `@cloudflare/codemode` ToolProvider; every MCP server is a
 * `CodemodeConnector` over Flue's MCP client, its methods typed from the
 * server's input and output schemas. `codemode.search(query)` ranks methods
 * across all of them and `codemode.describe(path)` returns their TypeScript
 * declarations — both run on the host and answer into the running script, so
 * a catalog of hundreds of methods costs the prompt nothing.
 *
 * `@cloudflare/codemode` is loaded on first use (its root module imports
 * `cloudflare:workers`, which Node only resolves once `@flue/runtime/node`
 * has installed its shim).
 */
import type * as Codemode from '@cloudflare/codemode';

export type CodemodeModule = typeof Codemode;

let loading: Promise<CodemodeModule> | undefined;

/** `@cloudflare/codemode`, imported once. */
export function loadCodemode(): Promise<CodemodeModule> {
	loading ??= import('@cloudflare/codemode');
	loading.catch(() => {
		loading = undefined;
	});
	return loading;
}

/** One callable method of a namespace. */
export interface CatalogMethod {
	/** Sandbox identifier (`namespace.<id>(input)`). */
	readonly id: string;
	/** The name the tool or server gave it. */
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: object;
	readonly outputSchema?: object;
	execute(input: unknown): Promise<unknown>;
}

/** One sandbox global: the agent's tools, or one MCP server. */
export interface CatalogNamespace {
	/** Sandbox identifier of the global. */
	readonly id: string;
	readonly kind: 'tools' | 'mcp';
	/** Human name: the MCP server's declared name, or "agent tools". */
	readonly title: string;
	readonly instructions?: string;
	readonly methods: readonly CatalogMethod[];
}

type JsonSchemaDescriptor = Codemode.JsonSchemaToolDescriptor;

type Description = {
	readonly namespace: CatalogNamespace;
	readonly descriptors: Record<string, JsonSchemaDescriptor>;
	readonly instructions?: string;
};

/** A namespace made executable for the sandbox, plus what discovery reads. */
export interface ResolvedNamespace {
	readonly provider: Codemode.ResolvedProvider;
	readonly description: Description;
}

const connectorClasses = new WeakMap<
	CodemodeModule,
	(namespace: CatalogNamespace) => Codemode.CodemodeConnector
>();

/**
 * The connector of one MCP server: `@cloudflare/codemode`'s
 * `CodemodeConnector` base over Flue's own MCP client (its `McpConnector`
 * expects an MCP SDK v1 connection). Built per module instance because the
 * base class comes from the lazily loaded package.
 */
function mcpConnector(cm: CodemodeModule, namespace: CatalogNamespace): Codemode.CodemodeConnector {
	let create = connectorClasses.get(cm);
	if (!create) {
		class FlueMcpConnector extends cm.CodemodeConnector {
			readonly #namespace: CatalogNamespace;
			constructor(source: CatalogNamespace) {
				// The base only stores ctx/env; connector calls never read them here.
				super({} as ExecutionContext, {});
				this.#namespace = source;
			}
			name(): string {
				return this.#namespace.id;
			}
			protected override instructions(): string | undefined {
				return this.#namespace.instructions;
			}
			protected tools(): Codemode.ConnectorTools {
				return Object.fromEntries(
					this.#namespace.methods.map((method) => [
						method.id,
						{
							...(method.description ? { description: method.description } : {}),
							inputSchema: method.inputSchema as never,
							...(method.outputSchema ? { outputSchema: method.outputSchema as never } : {}),
							execute: (input: unknown) => method.execute(input),
						},
					]),
				);
			}
		}
		create = (source) => new FlueMcpConnector(source);
		connectorClasses.set(cm, create);
	}
	return create(namespace);
}

/** Turn catalog namespaces into sandbox providers and their discovery data. */
export async function resolveNamespaces(
	cm: CodemodeModule,
	namespaces: readonly CatalogNamespace[],
	observe: (namespace: string, method: string, run: () => Promise<unknown>) => Promise<unknown>,
): Promise<ResolvedNamespace[]> {
	return Promise.all(
		namespaces.map(async (namespace): Promise<ResolvedNamespace> => {
			if (namespace.kind === 'mcp') {
				const connector = mcpConnector(cm, namespace);
				const described = await connector.describe();
				const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
				for (const method of namespace.methods) {
					fns[method.id] = (input?: unknown) =>
						observe(namespace.id, method.id, () => connector.executeTool(method.id, input ?? {}));
				}
				return {
					provider: { name: namespace.id, fns },
					description: {
						namespace,
						descriptors: described.descriptors,
						...(described.instructions ? { instructions: described.instructions } : {}),
					},
				};
			}
			const provider = cm.resolveProvider({
				name: namespace.id,
				tools: Object.fromEntries(
					namespace.methods.map((method) => [
						method.id,
						{
							...(method.description ? { description: method.description } : {}),
							execute: (input: unknown) =>
								observe(namespace.id, method.id, () => method.execute(input ?? {})),
						},
					]),
				),
			});
			return {
				provider,
				description: {
					namespace,
					descriptors: Object.fromEntries(
						namespace.methods.map((method) => [
							method.id,
							{
								...(method.description ? { description: method.description } : {}),
								inputSchema: method.inputSchema as never,
								...(method.outputSchema ? { outputSchema: method.outputSchema as never } : {}),
							},
						]),
					),
				},
			};
		}),
	);
}

// ─── codemode.search ───────────────────────────────────────────────────────

export interface SearchHit {
	readonly path: string;
	readonly namespace: string;
	readonly method: string;
	readonly description?: string;
	readonly score: number;
}

export interface SearchOutput {
	readonly results: readonly SearchHit[];
	readonly total: number;
	readonly truncated: boolean;
}

const SEARCH_LIMIT = 50;

function normalize(text: string): string {
	return text
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_./:-]+/g, ' ')
		.toLowerCase()
		.trim();
}

function tokens(text: string): string[] {
	return normalize(text)
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * Rank methods for a query. Every query token must match the method's path,
 * name or description (exactly, as a prefix, or as a substring); names
 * outweigh descriptions, and whole-phrase matches outweigh scattered ones.
 * At most 50 results; `truncated` says to search again more narrowly.
 */
export function searchCatalog(query: string, descriptions: readonly Description[]): SearchOutput {
	const queryTokens = tokens(query);
	const phrase = normalize(query);
	if (queryTokens.length === 0) return { results: [], total: 0, truncated: false };
	const hits: SearchHit[] = [];
	for (const { namespace, descriptors } of descriptions) {
		for (const method of namespace.methods) {
			const description = descriptors[method.id]?.description ?? method.description;
			const fields: [string[], string, number][] = [
				[tokens(method.id), normalize(method.id), 10],
				[tokens(method.name), normalize(method.name), 10],
				[tokens(namespace.id), normalize(namespace.id), 6],
				[tokens(description ?? ''), normalize(description ?? ''), 3],
			];
			let score = 0;
			let matched = 0;
			for (const token of queryTokens) {
				let best = 0;
				for (const [fieldTokens, raw, weight] of fields) {
					if (fieldTokens.includes(token)) best = Math.max(best, weight * 4);
					else if (fieldTokens.some((candidate) => candidate.startsWith(token)))
						best = Math.max(best, weight * 2);
					else if (raw.includes(token)) best = Math.max(best, weight);
				}
				if (best > 0) matched += 1;
				score += best;
			}
			if (matched < queryTokens.length) continue;
			for (const [, raw, weight] of fields) {
				if (raw === phrase) score += weight * 10;
				else if (raw.includes(phrase)) score += weight * 4;
			}
			hits.push({
				path: `${namespace.id}.${method.id}`,
				namespace: namespace.id,
				method: method.id,
				...(description ? { description } : {}),
				score,
			});
		}
	}
	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return {
		results: hits.slice(0, SEARCH_LIMIT),
		total: hits.length,
		truncated: hits.length > SEARCH_LIMIT,
	};
}

// ─── codemode.describe ─────────────────────────────────────────────────────

export interface DescribeOutput {
	readonly path: string;
	readonly kind: 'namespace' | 'method' | 'missing';
	readonly description?: string;
	/** TypeScript declarations: input and output types, and the call signature. */
	readonly types: string;
}

/**
 * TypeScript documentation for `"<namespace>"`, `"<namespace>.<method>"`, or
 * a bare method id when exactly one namespace has it. Output types come from
 * the method's output schema (`unknown` without one).
 */
export function describeCatalog(
	cm: CodemodeModule,
	target: string,
	descriptions: readonly Description[],
): DescribeOutput {
	const byId = new Map(descriptions.map((description) => [description.namespace.id, description]));
	const dot = target.indexOf('.');
	if (dot < 0) {
		const namespace = byId.get(target);
		if (namespace) {
			const types = cm
				.generateTypesFromJsonSchema(namespace.descriptors)
				.replace('declare const codemode', `declare const ${namespace.namespace.id}`);
			return {
				path: target,
				kind: 'namespace',
				...(namespace.instructions ? { description: namespace.instructions } : {}),
				types: namespace.instructions
					? `/* ${namespace.instructions.replace(/\*\//g, '* /')} */\n${types}`
					: types,
			};
		}
		const owners = descriptions.filter(
			(description) => description.descriptors[target] !== undefined,
		);
		if (owners.length === 1) return describeMethod(cm, owners[0] as Description, target);
		return {
			path: target,
			kind: 'missing',
			types:
				owners.length > 1
					? `"${target}" exists in ${owners.map((owner) => owner.namespace.id).join(', ')}; describe "<namespace>.${target}".`
					: `"${target}" not found. Use codemode.search(query) to find methods.`,
		};
	}
	const namespace = byId.get(target.slice(0, dot));
	const method = target.slice(dot + 1);
	if (namespace?.descriptors[method]) return describeMethod(cm, namespace, method);
	return {
		path: target,
		kind: 'missing',
		types: `"${target}" not found. Use codemode.search(query) to find methods.`,
	};
}

function describeMethod(
	cm: CodemodeModule,
	namespace: Description,
	method: string,
): DescribeOutput {
	const descriptor = namespace.descriptors[method] as JsonSchemaDescriptor;
	const types = cm
		.generateTypesFromJsonSchema({ [method]: descriptor })
		.replace('declare const codemode', `declare const ${namespace.namespace.id}`);
	return {
		path: `${namespace.namespace.id}.${method}`,
		kind: 'method',
		...(descriptor.description ? { description: descriptor.description } : {}),
		types,
	};
}
