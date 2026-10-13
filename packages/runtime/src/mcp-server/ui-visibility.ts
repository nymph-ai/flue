/**
 * MCP Apps 2026-01-26 visibility wire helpers.
 *
 * Stable spec exposes `_meta.ui.visibility` as a string array of surfaces
 * (`model`, `app`), not a single scalar token.
 */

import type { AppUiDefinition, RequestContext, ToolUiVisibility } from './types.ts';

export type UiClientSurface = 'model' | 'app';

const VISIBILITY_TO_ARRAY: Record<ToolUiVisibility, readonly UiClientSurface[]> = {
	all: ['model', 'app'],
	model: ['model'],
	app: ['app'],
};

export function visibilityWireValue(visibility: ToolUiVisibility | undefined): readonly UiClientSurface[] {
	return VISIBILITY_TO_ARRAY[visibility ?? 'all'];
}

export function resolveUiClientSurface(params?: Record<string, unknown>): UiClientSurface {
	const meta = (params?._meta ?? {}) as Record<string, unknown>;
	const uiMeta = (meta['io.modelcontextprotocol/ui'] ?? meta.ui) as Record<string, unknown> | undefined;
	const surface = uiMeta?.surface ?? params?.uiSurface ?? meta.uiSurface;
	if (surface === 'app' || surface === 'model') return surface;
	// Host bridge and sandbox iframes identify as app surface.
	if (params?.appSession === true || uiMeta?.appSession === true) return 'app';
	return 'model';
}

export function toolVisibleOnSurface(
	ui: AppUiDefinition | undefined,
	surface: UiClientSurface,
): boolean {
	if (!ui) return true;
	const allowed = visibilityWireValue(ui.visibility);
	return allowed.includes(surface);
}

export function assertToolCallableOnSurface(
	capabilityId: string,
	ui: AppUiDefinition | undefined,
	context: RequestContext,
	params?: Record<string, unknown>,
): void {
	const surface = resolveUiClientSurface(params);
	if (!toolVisibleOnSurface(ui, surface)) {
		throw new Error(
			`Tool '${capabilityId}' is app-only and cannot be invoked from the '${surface}' surface.`,
		);
	}
}
