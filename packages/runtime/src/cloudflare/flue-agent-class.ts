/**
 * Per-agent Durable Object class factory.
 *
 * The generated Cloudflare entry point collapses to
 * `export const FlueTriageAgent = createFlueAgentClass({...})` for each agent.
 *
 * The class is a plain `DurableObject` composed with the Agents SDK's
 * `Lifecycle` (`agents/lifecycle`). It does not extend `Agent`: `Agent`
 * installs State, WebSockets, Scheduler, Queue, Tasks, MCP and dynamic agents
 * on every object and migrates their tables on every new one, and Flue uses
 * none of them. Lifecycle supplies named-object identity (`lifecycle.name`),
 * startup (capabilities, then an extension's `onStart`, once per in-memory
 * lifetime) and request dispatch through capabilities. An extension adds the
 * capabilities it wants with `this.lifecycle.use(...)` in its constructor.
 *
 * Flue owns the object's alarm (`agent-coordinator.ts`): Lifecycle's job
 * queue costs several rows written per wake where Flue's alarm costs one
 * `setAlarm` or nothing, and the queue would overwrite or delete an alarm it
 * does not own. So capabilities that ride the job queue (`Scheduler`,
 * `Queue`, `Tasks`) are not supported here; `State` and `WebSockets` are.
 *
 * Semantics:
 * - `fetch` / `alarm` / the `__flueWake` doorbell RPC are the object's entry
 *   boundaries. Each establishes the instance context (#437) and starts the
 *   Lifecycle before it dispatches.
 * - `onRequest` serves Flue's routes; `alarm` is Flue's wake.
 * - The module's `extend({ base, wrap })` export is resolved via
 *   `resolveCloudflareExtension`: `base` reshapes the superclass, `wrap`
 *   wraps the final class, and the wrapped class is what gets exported.
 */
import type { CloudflareAgentRuntime, LifecycleLike } from './agent-coordinator.ts';
import { type ExtensionClass, resolveCloudflareExtension } from './extension.ts';

type CloudflareAgentInstance = Parameters<CloudflareAgentRuntime['attach']>[0];

interface LifecycleClass {
	install(host: object): LifecycleLike & {
		fetch(request: Request): Promise<Response>;
	};
}

export interface CreateFlueAgentClassOptions {
	/** `DurableObject` from `cloudflare:workers`. */
	readonly DurableObject: abstract new (ctx: any, env: any) => object;
	/**
	 * The Agents SDK `Lifecycle` (the generated entry imports it from the
	 * user's `agents/lifecycle`; `@flue/runtime` does not depend on `agents`).
	 */
	readonly Lifecycle: LifecycleClass;
	/** The shared per-Worker Cloudflare agent runtime (`createCloudflareAgentRuntime`). */
	readonly runtime: CloudflareAgentRuntime;
	/** Generated Durable Object class name, e.g. `FlueTriageAgent`. */
	readonly className: string;
	/** The agent's identity (file basename), e.g. `triage`. */
	readonly agentName: string;
	/**
	 * The agent module's `cloudflare` named export, if any — must be created
	 * with `extend({ base, wrap })` from `@flue/runtime/cloudflare`.
	 */
	readonly extension?: unknown;
}

/**
 * Build the final (possibly extension-wrapped) Durable Object class for one
 * agent module.
 */
export function createFlueAgentClass(options: CreateFlueAgentClassOptions): ExtensionClass<any> {
	const { DurableObject, Lifecycle, runtime, className, agentName, extension } = options;
	const resolved = resolveCloudflareExtension(
		extension === undefined ? {} : { cloudflare: extension },
		agentName,
		'Agent',
	);

	/**
	 * What an extension's `base` receives: the Durable Object with its
	 * Lifecycle already constructed, so a subclass constructor can install
	 * capabilities before startup.
	 */
	class FlueDurableObject extends DurableObject {
		readonly lifecycle = Lifecycle.install(this);

		/** The name the object was addressed by (`getByName`). */
		get name(): string {
			return this.lifecycle.name;
		}
	}

	const Base = resolved.base(FlueDurableObject);

	class FlueGeneratedAgent extends Base {
		constructor(ctx: unknown, env: unknown) {
			super(ctx, env);
			runtime.attach(this as unknown as CloudflareAgentInstance, { className, agentName });
		}

		fetch(request: Request) {
			return runtime.run(this as unknown as CloudflareAgentInstance, () =>
				this.lifecycle.fetch(request),
			);
		}

		/** Flue's wake (`agent-coordinator.ts`); the alarm is Flue's, not Lifecycle's job queue. */
		alarm() {
			return runtime.run(this as unknown as CloudflareAgentInstance, async () => {
				await this.lifecycle.start();
				return runtime.onAlarm(this as unknown as CloudflareAgentInstance);
			});
		}

		onRequest(request: Request) {
			return runtime.onRequest(this as unknown as CloudflareAgentInstance, request);
		}

		/**
		 * The doorbell RPC from the Worker's Electric wake route
		 * (`entity/webhook-route.ts`): `stream` — the instance's inbox, or a
		 * stream it observes — holds events through `head`. Records the
		 * high-water mark and, when that leaves the stream behind, the alarm in
		 * one synchronous turn, and returns; the alarm pumps
		 * (docs/cloudflare-native.md rules 3–4).
		 */
		__flueWake(doorbell: Parameters<CloudflareAgentRuntime['wake']>[1]) {
			return runtime.run(this as unknown as CloudflareAgentInstance, async () => {
				await this.lifecycle.start();
				return runtime.wake(this as unknown as CloudflareAgentInstance, doorbell);
			});
		}
	}

	// The codegen named each class `Flue<PascalCase>Agent`; preserve that for
	// diagnostics and platform wrappers that read `constructor.name`.
	Object.defineProperty(FlueGeneratedAgent, 'name', { value: className, configurable: true });

	return resolved.wrap(FlueGeneratedAgent as ExtensionClass<any>);
}
