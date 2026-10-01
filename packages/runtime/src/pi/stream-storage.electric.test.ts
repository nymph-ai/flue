/**
 * The StreamStorage crash/replay suite against a real Durable Streams server
 * through `ElectricDurableStreamLog`. Skipped unless `FLUE_DS_URL` names the
 * server's stream root (`…/v1/stream`); `scripts/test-durable-streams-server.sh`
 * starts the Node reference server and runs this file.
 */
import { describe } from 'vitest';
import { ElectricDurableStreamLog } from '../streams/electric-log.ts';
import { defineStreamStorageCrashTests } from './stream-storage-test-support.ts';

const env =
	(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const realServer = env.FLUE_DS_URL;

describe.skipIf(!realServer)('StreamStorage against FLUE_DS_URL', () => {
	defineStreamStorageCrashTests('crash matrix (ElectricDurableStreamLog, real server)', {
		log: () => new ElectricDurableStreamLog({ baseUrl: realServer as string }),
		pathPrefix: `flue/v1/storage-${crypto.randomUUID().slice(0, 8)}/`,
	});
});
