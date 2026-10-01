/**
 * A Code Mode host for Node tests: `@cloudflare/codemode`'s runtime exists
 * only inside workerd, so this stands in for its facet with the same
 * contract (`host.ts`): an execution log per execution, `requiresApproval`
 * methods pausing the execution with the call logged as pending, `approve`
 * continuing it by replaying the logged calls in order and running the
 * approved one, `reject` ending it. Its executions live in a map the test
 * keeps across "evictions", as the facet's SQLite outlives the agent's
 * memory. Scripts run in-process as async functions with the providers as
 * their only globals.
 *
 * The real runtime is exercised by `codemode.workers.test.ts` inside workerd.
 * Imported only by `*.test.ts`; never part of a build entry.
 */
import type { CodemodeExecutor, CodemodeProvider } from './executor.ts';
import {
	type CodemodeConnectorSpec,
	type CodemodeHost,
	type CodemodeLogEntry,
	type CodemodeOutcome,
	type CodemodeSession,
	registerCodemodeHost,
} from './host.ts';

type LoggedCall = {
	seq: number;
	connector: string;
	method: string;
	args: unknown;
	state: 'applied' | 'pending' | 'approved' | 'rejected';
	result?: unknown;
};

type StoredExecution = {
	code: string;
	calls: LoggedCall[];
	status: 'running' | 'paused' | 'completed' | 'error' | 'rejected';
};

class Paused extends Error {}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

/** Runs scripts in-process, with each provider as a global object of its functions. */
export const inProcessExecutor: CodemodeExecutor = {
	async execute(code, providers) {
		const names = providers.map((provider) => provider.name);
		const values = providers.map((provider) => ({ ...provider.fns }));
		const logs: string[] = [];
		const console = { log: (...parts: unknown[]) => logs.push(parts.map(String).join(' ')) };
		try {
			const run = new AsyncFunction(...names, 'console', `return await (${code})();`);
			return { result: await run(...values, console), logs };
		} catch (error) {
			if (error instanceof Paused) throw error;
			return { result: undefined, error: error instanceof Error ? error.message : String(error), logs };
		}
	},
};

export interface FakeCodemodeHost extends CodemodeHost {
	readonly executions: Map<string, StoredExecution>;
}

/** Create and register the fake host. */
export function installFakeCodemodeHost(): FakeCodemodeHost {
	const executions = new Map<string, StoredExecution>();
	let counter = 0;

	const host: FakeCodemodeHost = {
		runtimeName: 'flue',
		executions,
		open({ connectors, executor, wrapExecutor }): CodemodeSession {
			const wrapped = wrapExecutor(executor ?? inProcessExecutor);

			const run = async (executionId: string): Promise<CodemodeOutcome> => {
				const execution = executions.get(executionId);
				if (!execution) throw new Error(`no execution ${executionId}`);
				execution.status = 'running';
				let seq = 0;
				const call = async (
					connector: CodemodeConnectorSpec,
					method: string,
					requiresApproval: boolean,
					args: unknown,
					invoke: () => Promise<unknown>,
				): Promise<unknown> => {
					const position = seq++;
					const logged = execution.calls[position];
					if (logged) {
						if (logged.connector !== connector.name || logged.method !== method)
							throw new Error('the script took a different path on replay');
						if (logged.state === 'applied') return logged.result;
						if (logged.state === 'pending') throw new Paused();
						if (logged.state === 'rejected') throw new Error(`${connector.name}.${method} was rejected`);
						logged.result = await invoke();
						logged.state = 'applied';
						return logged.result;
					}
					if (requiresApproval) {
						execution.calls.push({ seq: position, connector: connector.name, method, args, state: 'pending' });
						throw new Paused();
					}
					const entry: LoggedCall = { seq: position, connector: connector.name, method, args, state: 'applied' };
					execution.calls.push(entry);
					entry.result = await invoke();
					return entry.result;
				};
				const providers: CodemodeProvider[] = connectors.map((connector) => ({
					name: connector.name,
					fns: Object.fromEntries(
						connector.methods.map((method) => [
							method.id,
							(args?: unknown) =>
								call(connector, method.id, method.requiresApproval, args, () =>
									connector.kind === 'tools'
										? (method as { execute(args: unknown): Promise<unknown> }).execute(args)
										: connector.call(
												(method as { toolName: string }).toolName,
												(args ?? {}) as Record<string, unknown>,
											),
								),
						]),
					),
				}));
				providers.push({ name: 'codemode', fns: {} });
				const calls = (): CodemodeLogEntry[] =>
					execution.calls.map((entry) => ({
						seq: entry.seq,
						connector: entry.connector,
						method: entry.method,
						state: entry.state,
					}));
				try {
					const outcome = await wrapped.execute(execution.code, providers);
					if (outcome.error !== undefined) {
						execution.status = 'error';
						return { status: 'error', executionId, error: outcome.error, logs: outcome.logs ?? [], calls: calls() };
					}
					execution.status = 'completed';
					return { status: 'completed', executionId, result: outcome.result, logs: outcome.logs ?? [], calls: calls() };
				} catch (error) {
					if (!(error instanceof Paused)) throw error;
					execution.status = 'paused';
					return {
						status: 'paused',
						executionId,
						pending: execution.calls
							.filter((entry) => entry.state === 'pending')
							.map((entry) => ({
								seq: entry.seq,
								connector: entry.connector,
								method: entry.method,
								args: entry.args,
							})),
						calls: calls(),
					};
				}
			};

			return {
				async execute(code) {
					const executionId = `exec_${++counter}`;
					executions.set(executionId, { code, calls: [], status: 'running' });
					return run(executionId);
				},
				async approve(executionId) {
					const execution = executions.get(executionId);
					if (execution?.status !== 'paused') throw new Error(`execution ${executionId} is not paused`);
					for (const entry of execution.calls) if (entry.state === 'pending') entry.state = 'approved';
					return run(executionId);
				},
				async reject(executionId, seqs) {
					const execution = executions.get(executionId);
					if (execution?.status !== 'paused') return false;
					for (const entry of execution.calls) {
						if (seqs.includes(entry.seq) && entry.state === 'pending') entry.state = 'rejected';
					}
					execution.status = 'rejected';
					return true;
				},
			};
		},
	};
	registerCodemodeHost(host);
	return host;
}
