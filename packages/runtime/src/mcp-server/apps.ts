/**
 * Apps Manager & Additive UI Projections.
 *
 * Implements MCP Apps as an optional additive presentation layer.
 *
 * INVARIANT: Every App-backed tool is 100% semantically complete without rendering.
 * It must always return structuredContent and readable text content.
 *
 * Reference: docs/mcp-capability-projection.md § 8
 */

import type { AppUiDefinition, CapabilityResult } from './types.ts';

export class AppManager {
	private readonly views = new Map<string, { html: string; definition: AppUiDefinition }>();

	/**
	 * Register an interactive App UI view.
	 */
	registerView(definition: AppUiDefinition, html: string): void {
		this.views.set(definition.viewUri, { html, definition });
	}

	/**
	 * Read ui:// URI.
	 */
	readUiResource(uri: string): { content: string; mimeType: string } {
		const view = this.views.get(uri);
		if (!view) {
			throw new Error(`UI View '${uri}' not found.`);
		}
		return {
			content: view.html,
			mimeType: 'text/html',
		};
	}

	/**
	 * List all UI resources for resources/list.
	 */
	listUiResources(): Array<{ uri: string; name: string; description: string; mimeType: string }> {
		const result: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];
		for (const [uri, view] of this.views.entries()) {
			result.push({
				uri,
				name: view.definition.viewUri,
				description: view.definition.description ?? 'Interactive App View',
				mimeType: 'text/html',
			});
		}
		return result.sort((a, b) => a.uri.localeCompare(b.uri));
	}

	/**
	 * Assert that a tool result with an attached App UI is semantically complete.
	 * Throws if the result lacks structuredContent or text content.
	 */
	static assertSemanticCompleteness(result: CapabilityResult, toolId: string): void {
		if (result.uiUri) {
			const hasText = result.content?.some((c) => c.type === 'text' && c.text.trim().length > 0);
			const hasStructured =
				result.structuredContent !== undefined &&
				Object.keys(result.structuredContent).length > 0;

			if (!hasText && !hasStructured) {
				throw new Error(
					`Tool '${toolId}' returns uiUri '${result.uiUri}' but lacks structuredContent or text content. Every App-backed tool must be semantically complete without rendering.`,
				);
			}
		}
	}
}
