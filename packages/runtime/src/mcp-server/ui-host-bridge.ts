/**
 * MCP Apps view ↔ host JSON-RPC surface (2026-01-26 stable subset).
 *
 * Hosts mediate privileged tools/call and resources/read; views speak ui/* only.
 * This module validates and answers the server-side host bridge methods Flue
 * exposes when acting as an MCP Apps-capable host proxy (first-party + tests).
 */

export interface UiHostContext {
	theme?: 'light' | 'dark';
	locale?: string;
	displayMode?: 'inline' | 'fullscreen' | 'pip';
}

export interface UiInitializeParams {
	appCapabilities?: Record<string, unknown>;
}

export interface UiInitializeResult {
	protocolVersion: string;
	hostContext?: UiHostContext;
	hostCapabilities?: Record<string, unknown>;
}

export interface UiHostBridgeActions {
	readonly openLink?: (url: string) => Promise<void> | void;
	readonly updateModelContext?: (payload: Record<string, unknown>) => Promise<void> | void;
	readonly requestDisplayMode?: (mode: string) => Promise<boolean> | boolean;
}

const UI_METHOD_PREFIX = 'ui/';

export function isUiMethod(method: string): boolean {
	return method.startsWith(UI_METHOD_PREFIX);
}

export function handleUiHostMethod(
	method: string,
	params: Record<string, unknown>,
	actions?: UiHostBridgeActions,
): Record<string, unknown> {
	switch (method) {
		case 'ui/initialize': {
			const init = params as UiInitializeParams;
			return {
				resultType: 'complete',
				protocolVersion: '2026-01-26',
				hostContext: {
					theme: 'dark',
					locale: 'en-US',
					displayMode: 'inline',
				},
				hostCapabilities: {
					openLinks: Boolean(actions?.openLink),
					displayMode: ['inline', 'fullscreen'],
					updateModelContext: Boolean(actions?.updateModelContext),
				},
				...(init.appCapabilities ? { negotiatedAppCapabilities: init.appCapabilities } : {}),
			};
		}
		case 'ping':
			return { resultType: 'complete' };
		case 'ui/open-link': {
			const url = String(params.url ?? '');
			if (!url.startsWith('https://') && !url.startsWith('http://')) {
				throw new Error('ui/open-link requires http(s) URL');
			}
			if (!actions?.openLink) {
				throw { code: -32601, message: 'Host does not implement ui/open-link' };
			}
			return { resultType: 'complete', opened: true, url };
		}
		case 'ui/update-model-context': {
			if (!actions?.updateModelContext) {
				throw { code: -32601, message: 'Host does not implement ui/update-model-context' };
			}
			return { resultType: 'complete', accepted: true };
		}
		case 'ui/request-display-mode': {
			if (!actions?.requestDisplayMode) {
				throw { code: -32601, message: 'Host does not implement ui/request-display-mode' };
			}
			const mode = String(params.mode ?? 'inline');
			const granted = actions.requestDisplayMode(mode);
			return {
				resultType: 'complete',
				accepted: granted instanceof Promise ? true : granted,
				mode,
			};
		}
		case 'ui/message':
			return { resultType: 'complete', accepted: true };
		default:
			if (method.startsWith('ui/notifications/')) {
				return { resultType: 'complete', acknowledged: true };
			}
			throw { code: -32601, message: `Method not found: ${method}` };
	}
}

export async function performUiHostSideEffects(
	method: string,
	params: Record<string, unknown>,
	actions?: UiHostBridgeActions,
): Promise<void> {
	if (method === 'ui/open-link' && actions?.openLink) {
		await actions.openLink(String(params.url ?? ''));
	}
	if (method === 'ui/update-model-context' && actions?.updateModelContext) {
		await actions.updateModelContext(params as Record<string, unknown>);
	}
	if (method === 'ui/request-display-mode' && actions?.requestDisplayMode) {
		await actions.requestDisplayMode(String(params.mode ?? 'inline'));
	}
}
