import { afterAll } from 'vitest';
import { NodeCodemodeExecutor } from '../node/codemode-node.ts';
import { defineCodemodeSuite } from './suite.ts';

const executor = new NodeCodemodeExecutor({ timeoutMs: 20_000 });
afterAll(() => executor.close());

/** The Node target: a `node:vm` context in a worker thread (no isolation). */
defineCodemodeSuite('NodeCodemodeExecutor', () => executor);
