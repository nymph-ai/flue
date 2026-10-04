/**
 * MCP Subscription Durable Object class for Cloudflare.
 *
 * Implements `__mcpWake({ stream, head })` RPC called from the Worker's Electric wake route
 * (`entity/webhook-route.ts` / `worker-config.ts`), pumping external subscriptions
 * via `ElectricEventPort.processDoorbell(stream, head)`.
 */
import type { EntityDoorbell } from '../entity/webhook-route.ts';
import { ElectricEventPort } from '../mcp-server/events.ts';
import { configuredStreamsLog } from '../runtime/streams-config.ts';
import type { DurableStreamLog } from '../streams/log.ts';

export const MCP_SUBSCRIPTION_BINDING = 'FLUE_MCP_SUBSCRIPTIONS';
export const MCP_SUBSCRIPTION_CLASS_NAME = 'FlueMcpSubscription';

export interface McpSubscriptionStub {
	__mcpWake(doorbell: EntityDoorbell): Promise<{ readonly recorded: true }>;
	readonly eventPort: ElectricEventPort;
}

type DurableObjectBase = new (ctx: any, env: any) => object;

export interface CreateFlueMcpSubscriptionClassOptions {
	/** `DurableObject` base from `cloudflare:workers`. */
	readonly DurableObject: DurableObjectBase;
	/** The shared DurableStreamLog (Electric). Optional; resolved from env when omitted. */
	readonly streamLog?: DurableStreamLog;
}

export function createFlueMcpSubscriptionClass(
	options: CreateFlueMcpSubscriptionClassOptions,
): new (ctx: { storage: { sql?: any } }, env: unknown) => McpSubscriptionStub {
	const { DurableObject, streamLog } = options;

	return class FlueMcpSubscription extends DurableObject implements McpSubscriptionStub {
		readonly eventPort: ElectricEventPort;

		constructor(ctx: { storage: { sql?: any } }, env: unknown) {
			super(ctx, env);
			const log = streamLog ?? configuredStreamsLog(env as Record<string, unknown> | undefined);
			this.eventPort = new ElectricEventPort({
				sql: ctx.storage.sql,
				...(log ? { streamLog: log } : {}),
			});
		}

		async __mcpWake(doorbell: EntityDoorbell): Promise<{ readonly recorded: true }> {
			await this.eventPort.processDoorbell(doorbell.stream, doorbell.head);
			return { recorded: true };
		}
	};
}
