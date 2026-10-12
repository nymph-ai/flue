/**
 * Apps Manager & Additive UI Projections.
 *
 * Implements MCP Apps as an optional additive presentation layer.
 *
 * INVARIANT: Every App-backed tool is 100% semantically complete without rendering.
 * It must always return structuredContent and readable text content.
 *
 * Reference: docs/mcp-capability-projection.md § 8
 * MCP Apps stable: text/html;profile=mcp-app, _meta.ui on resource content.
 */

import type { AppUiDefinition, CapabilityResult, McpUiResourceMeta } from './types.ts';
import { MCP_APP_HTML_MIME } from './types.ts';

interface RegisteredView {
	html: string;
	definition: AppUiDefinition;
	meta: McpUiResourceMeta;
}

export class AppManager {
	private readonly views = new Map<string, RegisteredView>();

	/**
	 * Register an interactive App UI view.
	 */
	registerView(definition: AppUiDefinition, html: string, meta?: McpUiResourceMeta): void {
		this.views.set(definition.viewUri, {
			html,
			definition,
			meta: meta ?? definition.meta ?? {},
		});
	}

	/**
	 * Read ui:// URI for resources/read.
	 */
	readUiResource(uri: string): {
		content: string;
		mimeType: string;
		_meta: { ui: McpUiResourceMeta };
	} {
		const view = this.views.get(uri);
		if (!view) {
			throw new Error(`UI View '${uri}' not found.`);
		}
		return {
			content: view.html,
			mimeType: MCP_APP_HTML_MIME,
			_meta: { ui: view.meta },
		};
	}

	/**
	 * List all UI resources for resources/list.
	 */
	listUiResources(): Array<{
		uri: string;
		name: string;
		description: string;
		mimeType: string;
		_meta?: { ui: McpUiResourceMeta };
	}> {
		const result: Array<{
			uri: string;
			name: string;
			description: string;
			mimeType: string;
			_meta?: { ui: McpUiResourceMeta };
		}> = [];
		for (const [uri, view] of this.views.entries()) {
			result.push({
				uri,
				name: view.definition.viewUri,
				description: view.definition.description ?? 'Interactive App View',
				mimeType: MCP_APP_HTML_MIME,
				_meta: { ui: view.meta },
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
				result.structuredContent !== undefined && Object.keys(result.structuredContent).length > 0;

			if (!hasText && !hasStructured) {
				throw new Error(
					`Tool '${toolId}' returns uiUri '${result.uiUri}' but lacks structuredContent or text content. Every App-backed tool must be semantically complete without rendering.`,
				);
			}
		}
	}
}
