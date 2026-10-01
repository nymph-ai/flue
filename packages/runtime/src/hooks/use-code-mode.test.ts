import { describe, expect, it } from 'vitest';
import type { CodemodeExecutor } from '../pi/codemode/executor.ts';
import { renderWithFrame } from './frame.ts';
import { readCodeModeDeclaration, useCodeMode } from './use-code-mode.ts';

const executor: CodemodeExecutor = {
	execute: async () => ({ ok: true, value: undefined, output: [], calls: [], storeWrites: { set: {}, delete: [] } }),
	close: async () => {},
};

describe('useCodeMode', () => {
	it('records one frozen declaration per render', () => {
		const { frame } = renderWithFrame(() => useCodeMode({ executor, timeoutMs: 5_000 }));
		const declaration = readCodeModeDeclaration(frame);
		expect(declaration).toEqual({ executor, timeoutMs: 5_000 });
		expect(Object.isFrozen(declaration)).toBe(true);
		expect(readCodeModeDeclaration(renderWithFrame(() => undefined).frame)).toBeUndefined();
	});

	it('rejects a second declaration, a missing executor, and unknown options', () => {
		expect(() =>
			renderWithFrame(() => {
				useCodeMode({ executor });
				useCodeMode({ executor });
			}),
		).toThrow(/called twice in one render/);
		expect(() => renderWithFrame(() => useCodeMode({} as never))).toThrow(/requires `executor`/);
		expect(() => renderWithFrame(() => useCodeMode({ executor, timeout: 1 } as never))).toThrow(
			/unknown option "timeout"/,
		);
		expect(() => renderWithFrame(() => useCodeMode({ executor, maxOutputTokens: 0 }))).toThrow(
			/maxOutputTokens must be a positive number/,
		);
	});

	it('only runs inside a render', () => {
		expect(() => useCodeMode({ executor })).toThrow(/outside an agent function/);
	});
});
