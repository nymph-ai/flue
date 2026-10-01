import { env } from 'cloudflare:workers';
import { createCodemodeExecutor } from '../cloudflare/codemode.ts';
import { defineCodemodeSuite } from './suite.ts';

/**
 * The Cloudflare target, inside workerd: `@cloudflare/codemode`'s
 * DynamicWorkerExecutor over Miniflare's Worker Loader, no outbound network.
 */
defineCodemodeSuite('DynamicWorkerExecutor (Worker Loader)', () =>
	createCodemodeExecutor({ loader: (env as unknown as { LOADER: WorkerLoader }).LOADER }),
);
