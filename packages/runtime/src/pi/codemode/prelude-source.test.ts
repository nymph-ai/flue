import { describe, expect, it } from 'vitest';
import * as vendored from './prelude-source.ts';

/**
 * Flue's Dynamic Worker executor evaluates a vendored copy of Pi's prelude.
 * It must stay byte-identical to the installed Pi release, which the package
 * `exports` map hides — so resolve the root entry and read its sibling.
 */
describe('vendored pi-codemode prelude', () => {
	it('matches the installed @earendil-works/pi-codemode prelude exactly', async () => {
		const root = import.meta.resolve('@earendil-works/pi-codemode');
		const pi = (await import(
			/* @vite-ignore */ new URL('./runtime/prelude-source.js', root).href
		)) as typeof vendored;
		expect(vendored.PRELUDE_SOURCE).toBe(pi.PRELUDE_SOURCE);
		expect(vendored.MAX_STORE_VALUE_CHARS).toBe(pi.MAX_STORE_VALUE_CHARS);
		expect(vendored.MAX_STORE_TOTAL_CHARS).toBe(pi.MAX_STORE_TOTAL_CHARS);
	});
});
