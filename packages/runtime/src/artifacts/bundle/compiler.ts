/**
 * Agent-generated HTML bundle compiler (P22-A4).
 *
 * Validates size/runtime limits, computes reproducible digest, strips obvious
 * credential patterns, and emits MCP Apps CSP metadata for registry publication.
 */

import type { McpUiResourceMeta } from '../../mcp-server/types.ts';
import { digestBundle } from '../registry.ts';

export interface BundleCompileOptions {
	maxBytes?: number;
	connectDomains?: string[];
	resourceDomains?: string[];
}

export interface CompiledArtifactBundle {
	html: string;
	digest: string;
	byteLength: number;
	meta: McpUiResourceMeta;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

const FORBIDDEN_PATTERNS: RegExp[] = [
	/\bapi[_-]?key\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}/i,
	/\bBearer\s+[a-zA-Z0-9._\-]{20,}/,
	/\bsk-[a-zA-Z0-9]{20,}/,
];

export function compileHtmlArtifactBundle(
	html: string,
	options: BundleCompileOptions = {},
): CompiledArtifactBundle {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const bytes = Buffer.from(html, 'utf8');
	if (bytes.byteLength > maxBytes) {
		throw new Error(`HTML bundle exceeds maxBytes (${maxBytes})`);
	}
	for (const pattern of FORBIDDEN_PATTERNS) {
		if (pattern.test(html)) {
			throw new Error('HTML bundle contains forbidden credential-like pattern');
		}
	}
	if (!html.includes('<') || !html.toLowerCase().includes('html')) {
		throw new Error('HTML bundle must contain an html document');
	}

	return {
		html,
		digest: digestBundle(html),
		byteLength: bytes.byteLength,
		meta: {
			csp: {
				connectDomains: options.connectDomains ?? [],
				resourceDomains: options.resourceDomains ?? [],
				frameDomains: [],
				baseUriDomains: [],
			},
			prefersBorder: true,
		},
	};
}
