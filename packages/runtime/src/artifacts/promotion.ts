/**
 * Explicit promotion from an ephemeral generated HTML response to a
 * versioned artifact draft (P22-A9).
 *
 * Promotion never publishes and never reinvokes a model. Live state updates
 * patch the read model; they do not regenerate HTML.
 */

import { compileHtmlArtifactBundle, type CompiledArtifactBundle } from './bundle/compiler.ts';

export interface PromotionDraft {
	readonly artifactId: string;
	readonly reviewRequired: true;
	readonly bundle: CompiledArtifactBundle;
	readonly streamId: string;
	readonly published: false;
}

export function promoteEphemeralHtml(input: {
	readonly artifactId: string;
	readonly tenantId: string;
	readonly html: string;
	readonly connectDomains?: string[];
}): PromotionDraft {
	const bundle = compileHtmlArtifactBundle(input.html, {
		connectDomains: input.connectDomains,
	});
	return {
		artifactId: input.artifactId,
		reviewRequired: true,
		bundle,
		streamId: `flue/v1/artifact/${input.tenantId}/${artifactSlug(input.artifactId)}/events`,
		published: false,
	};
}

function artifactSlug(artifactId: string): string {
	const parts = artifactId.replace(/^artifact:\/\//, '').split('/');
	return parts[parts.length - 1] || 'artifact';
}
