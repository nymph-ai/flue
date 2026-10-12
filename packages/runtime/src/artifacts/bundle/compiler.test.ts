import { describe, expect, it } from 'vitest';
import { compileHtmlArtifactBundle } from './compiler.ts';

describe('compileHtmlArtifactBundle', () => {
	it('computes stable digest for identical html', () => {
		const html = '<!doctype html><html><body>ok</body></html>';
		const a = compileHtmlArtifactBundle(html);
		const b = compileHtmlArtifactBundle(html);
		expect(a.digest).toBe(b.digest);
		expect(a.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it('rejects credential-like patterns', () => {
		const html = '<html><script>const api_key = "sk-abcdefghijklmnopqrstuvwxyz123456"</script></html>';
		expect(() => compileHtmlArtifactBundle(html)).toThrow(/forbidden credential/);
	});
});
