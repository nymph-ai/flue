import { fnv1a64 } from '../fnv.ts';

/** Words `@cloudflare/codemode`'s `sanitizeToolName` suffixes with `_`, and more. */
const RESERVED = new Set([
	'abstract',
	'arguments',
	'await',
	'boolean',
	'break',
	'byte',
	'case',
	'catch',
	'char',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'double',
	'else',
	'enum',
	'eval',
	'export',
	'extends',
	'false',
	'final',
	'finally',
	'float',
	'for',
	'function',
	'goto',
	'if',
	'implements',
	'import',
	'in',
	'instanceof',
	'int',
	'interface',
	'let',
	'long',
	'native',
	'new',
	'null',
	'package',
	'private',
	'protected',
	'public',
	'return',
	'short',
	'static',
	'super',
	'switch',
	'synchronized',
	'this',
	'throw',
	'throws',
	'transient',
	'true',
	'try',
	'typeof',
	'undefined',
	'var',
	'void',
	'volatile',
	'while',
	'with',
	'yield',
]);

/**
 * Names the sandbox already uses: the executor's own globals, and the
 * platform namespace. A namespace never takes one of them.
 */
const SANDBOX_GLOBALS = new Set([
	'codemode',
	'console',
	'Promise',
	'Error',
	'setTimeout',
	'WorkerEntrypoint',
	'CodeExecutor',
	'globalThis',
	'Object',
	'Array',
	'JSON',
	'Math',
	'Date',
	'String',
	'Number',
	'Boolean',
	'Symbol',
	'Map',
	'Set',
	'Proxy',
	'Reflect',
]);

/**
 * A JavaScript identifier for a name, the way `@cloudflare/codemode`'s
 * `sanitizeToolName` makes one (so its dispatcher leaves it unchanged).
 */
export function toIdentifier(name: string): string {
	let id = name.replace(/[-.\s]/g, '_').replace(/[^a-zA-Z0-9_$]/g, '');
	if (!id) id = '_';
	if (/^[0-9]/.test(id)) id = `_${id}`;
	if (RESERVED.has(id)) id = `${id}_`;
	return id;
}

/**
 * Identifiers for a list of names, unique within the list and away from
 * `taken`. A name whose plain identifier is free keeps it; otherwise — two
 * names that differ only by `-` and `_`, say — each colliding name gets a
 * stable `_<hash>` suffix of its original, so neither depends on the other's
 * presence.
 */
export function uniqueIdentifiers(
	names: readonly string[],
	taken: ReadonlySet<string> = new Set(),
): Map<string, string> {
	const plain = names.map((name) => toIdentifier(name));
	const counts = new Map<string, number>();
	for (const id of plain) counts.set(id, (counts.get(id) ?? 0) + 1);
	const out = new Map<string, string>();
	const used = new Set(taken);
	names.forEach((name, index) => {
		const id = plain[index] as string;
		let chosen =
			(counts.get(id) ?? 0) > 1 || used.has(id) ? `${id}_${fnv1a64(name).slice(0, 6)}` : id;
		while (used.has(chosen)) chosen = `${chosen}_`;
		used.add(chosen);
		out.set(name, chosen);
	});
	return out;
}

/** Namespace identifiers: unique, and never a sandbox global. */
export function namespaceIdentifiers(
	names: readonly string[],
	taken: readonly string[] = [],
): Map<string, string> {
	return uniqueIdentifiers(names, new Set([...SANDBOX_GLOBALS, ...taken]));
}
