import type { DurableObject } from 'cloudflare:workers';

const CLOUDFLARE_EXTENSION = Symbol.for('@flue/runtime/cloudflare-extension');

/**
 * Minimal structural view of the class Flue passes to `extend()` callbacks:
 * a `DurableObject` composed with the Cloudflare Agents SDK `Lifecycle`
 * (`agents/lifecycle`). An extension installs SDK capabilities that do not
 * use the alarm (`State` from `agents/state`, `WebSockets` from
 * `agents/websockets`) with `this.lifecycle.use(...)` in its constructor.
 * Capabilities that ride Lifecycle's job queue (`Scheduler`, `Queue`,
 * `Tasks`) are not supported: Flue owns the object's alarm. `@flue/runtime`
 * does not depend on the `agents` package, so this models only that surface;
 * pass an explicit `TBase` to `extend()` to type against a richer class shape.
 */
export interface CloudflareAgentLike {
	/** The name the object was addressed by. */
	readonly name: string;
	readonly lifecycle: {
		readonly name: string;
		/** Add a capability; only before startup, so call it from a constructor. */
		use(capability: object): unknown;
		start(): Promise<void>;
	};
	/** Runs once per in-memory lifetime, after capabilities start and before work is handled. */
	onStart?(props?: Record<string, unknown>): Promise<void> | void;
}

export type ExtensionClass<TInstance extends object = CloudflareAgentLike> = new (
	...args: any[]
) => TInstance;

/**
 * The class shape Flue hands to `base` and `wrap`: every class the generated
 * Cloudflare entry passes in is a real, branded `DurableObject` with an
 * Agents SDK `Lifecycle`. The `cloudflare:workers` import is type-only, so
 * this module's runtime graph stays free of that virtual module; consumers of
 * `@flue/runtime/cloudflare` are expected to have Cloudflare's workers types
 * configured (any Wrangler project does).
 *
 * This is deliberately a concrete constructor type rather than a
 * `<TClass extends ...>` generic: inside a generic callback the class is an
 * opaque type parameter, and TypeScript will not infer a downstream wrapper's
 * type parameters (e.g. Sentry's `instrumentDurableObjectWithSentry`) from a
 * type parameter's constraint, so a generic signature here forces consumers
 * back to the runtime assertions this type exists to eliminate.
 */
export type GeneratedDurableObjectClass<
	TInstance extends object = CloudflareAgentLike,
	TEnv = any,
> = new (ctx: DurableObjectState, env: TEnv) => TInstance & DurableObject<TEnv>;

export interface CloudflareExtension<TBase extends object = CloudflareAgentLike, TEnv = any> {
	base?: (Base: GeneratedDurableObjectClass<TBase, TEnv>) => ExtensionClass<TBase>;
	wrap?: (
		Final: GeneratedDurableObjectClass<TBase, TEnv>,
	) => GeneratedDurableObjectClass<TBase, TEnv>;
}

interface BrandedCloudflareExtension extends CloudflareExtension<any> {
	[CLOUDFLARE_EXTENSION]: true;
}

/** Runtime-resolved extension; classes are opaque to the generated entry. */
export interface ResolvedCloudflareExtension {
	base(Base: ExtensionClass<any>): ExtensionClass<any>;
	wrap(Final: ExtensionClass<any>): ExtensionClass<any>;
}

export function extend<TBase extends object = CloudflareAgentLike, TEnv = any>(
	extension: CloudflareExtension<TBase, TEnv>,
): CloudflareExtension<TBase, TEnv> {
	if (typeof extension !== 'object' || extension === null || Array.isArray(extension)) {
		throw new Error(
			'[flue] extend() expects an object containing optional base and wrap callbacks.',
		);
	}
	const unknownKeys = Object.keys(extension).filter((key) => key !== 'base' && key !== 'wrap');
	if (unknownKeys.length > 0) {
		throw new Error(`[flue] extend() received unknown option(s): ${unknownKeys.join(', ')}.`);
	}
	const branded: BrandedCloudflareExtension = {
		...extension,
		[CLOUDFLARE_EXTENSION]: true,
	};
	return branded;
}

export function resolveCloudflareExtension(
	mod: Record<string, unknown>,
	name: string,
	kind: 'Agent',
): ResolvedCloudflareExtension {
	const extension = mod.cloudflare;
	if (extension === undefined) return { base: identity, wrap: identity };
	if (!isCloudflareExtension(extension)) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare export must be created with extend({ base, wrap }) from "@flue/runtime/cloudflare".`,
		);
	}
	const base = extension.base === undefined ? identity : extension.base;
	const wrap = extension.wrap === undefined ? identity : extension.wrap;
	if (typeof base !== 'function') {
		throw new Error(`[flue] ${kind} "${name}" cloudflare.base must be a function.`);
	}
	if (typeof wrap !== 'function') {
		throw new Error(`[flue] ${kind} "${name}" cloudflare.wrap must be a function.`);
	}
	return {
		base(Base) {
			return assertExtensionClass(base(Base), Base, name, kind);
		},
		wrap(Final) {
			return assertExtensionWrapper(wrap(Final), Final, name, kind);
		},
	};
}

function identity<T>(value: T): T {
	return value;
}

function isCloudflareExtension(value: unknown): value is CloudflareExtension<any> {
	return (
		typeof value === 'object' &&
		value !== null &&
		CLOUDFLARE_EXTENSION in value &&
		(value as BrandedCloudflareExtension)[CLOUDFLARE_EXTENSION] === true
	);
}

function assertExtensionClass(
	value: unknown,
	Base: ExtensionClass<any>,
	name: string,
	kind: string,
): ExtensionClass<any> {
	if (
		typeof value !== 'function' ||
		(value !== Base && !(value.prototype instanceof Base)) ||
		!isConstructable(value as ExtensionClass<any>)
	) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare.base must return the received class or a subclass.`,
		);
	}
	return value as ExtensionClass<any>;
}

function assertExtensionWrapper(
	value: unknown,
	Final: ExtensionClass<any>,
	name: string,
	kind: string,
): ExtensionClass<any> {
	if (
		typeof value !== 'function' ||
		(value !== Final && value.prototype !== Final.prototype) ||
		!isConstructable(value as ExtensionClass<any>)
	) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare.wrap(Final) must return the received class or a constructor proxy.`,
		);
	}
	return value as ExtensionClass<any>;
}

function isConstructable(value: ExtensionClass<any>): boolean {
	try {
		Reflect.construct(Function, [], value);
		return true;
	} catch {
		return false;
	}
}
