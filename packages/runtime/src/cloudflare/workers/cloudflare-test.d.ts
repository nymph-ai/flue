/** The slice of `@cloudflare/vitest-pool-workers`' `cloudflare:test` module the workers tests use. */
declare module 'cloudflare:test' {
	export const env: unknown;
	export function runInDurableObject<R>(
		stub: DurableObjectStub,
		callback: (instance: unknown, state: DurableObjectState) => R | Promise<R>,
	): Promise<R>;
	export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
	export function evictDurableObject(stub: DurableObjectStub): Promise<void>;
}
