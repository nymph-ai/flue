/**
 * `@cloudflare/codemode`'s root module imports `cloudflare:workers` for its
 * base classes (`WorkerEntrypoint`, `DurableObject`, `RpcTarget`), which only
 * workerd provides. On Node, Code Mode still needs the package — the
 * connector base, type generation, code normalization — so this registers a
 * module-resolution hook that answers `cloudflare:workers` with plain
 * classes. Nothing here is a Workers runtime: no RPC, no isolation.
 */
import { registerHooks } from 'node:module';

const SHIM_SOURCE = [
	'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
	'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
	'export class RpcTarget {}',
	'export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
	'export const env = {};',
].join('\n');

const SHIM_URL = `data:text/javascript,${encodeURIComponent(SHIM_SOURCE)}`;

let installed = false;

/** Resolve `cloudflare:workers` to the shim from now on (idempotent). */
export function installCloudflareWorkersShim(): void {
	if (installed) return;
	installed = true;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === 'cloudflare:workers') {
				return { url: SHIM_URL, format: 'module', shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
}
