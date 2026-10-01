/**
 * Drive an entity of `codemode-turn.ts` the way the society does: messages
 * appended to its inbox on the in-isolate Durable Streams server, the
 * Worker's wake route ringing its doorbell, and its alarms run until each
 * admitted submission settles. Imported only by `*.workers.test.ts`.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { spawnedUid } from '../../entity/facet.ts';
import { eventsPath, inboxPath } from '../../entity/paths.ts';
import { ElectricDurableStreamLog } from '../../streams/electric-log.ts';
import { STREAMS_ROOT, streamsServer } from './first-wake.ts';
import { sqlTrace } from './sql-trace.ts';

export type WakeStub = DurableObjectStub & {
	__flueWake(doorbell: { stream: string; head: string }): Promise<{ recorded: true }>;
};

const namespace = (env as unknown as { CODEMODE_TURN: DurableObjectNamespace }).CODEMODE_TURN;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settledSubmissions(stub: WakeStub): Promise<number> {
	return runInDurableObject(stub, (_instance, state) =>
		sqlTrace.unrecorded(() => {
			try {
				const row = state.storage.sql
					.exec("SELECT count(*) AS n FROM submissions WHERE status = 'done'")
					.one() as { n: number };
				return row.n;
			} catch {
				return 0;
			}
		}),
	);
}

/** A new `carol` entity, born from a spawn message; `say(text)` runs one more turn. */
export async function carol(id: string) {
	const parent = { type: 'alice', id: `alice-${id}` };
	const child = { type: 'carol', id: `${parent.id}/${id}` };
	const log = new ElectricDurableStreamLog({ baseUrl: STREAMS_ROOT, fetch: streamsServer.fetch });
	await log.ensure(inboxPath(child));
	await log.ensure(eventsPath(child));
	const stub = (await getAgentByName(namespace as never, child.id)) as unknown as WakeStub;
	let sent = 0;
	const say = async (text: string, spawn = false) => {
		const { nextOffset } = await log.append(inboxPath(child), [
			{
				type: 'flue.a2a.message',
				from: parent,
				messageId: `${parent.type}/${parent.id}/m${++sent}`,
				message: { text },
				...(spawn ? { directive: { kind: 'spawn', uid: await spawnedUid(child) } } : {}),
			},
		]);
		await stub.__flueWake({ stream: inboxPath(child), head: nextOffset });
		const deadline = Date.now() + 30_000;
		while ((await settledSubmissions(stub)) < sent) {
			if (Date.now() > deadline) throw new Error(`no ${sent} settled submissions after 30 s`);
			await runDurableObjectAlarm(stub);
			await sleep(100);
		}
	};
	await say('You were born.', true);
	return { stub, say };
}
