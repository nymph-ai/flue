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

const UI_METHOD_PREFIX = 'ui/';

export function isUiMethod(method: string): boolean {
	return method.startsWith(UI_METHOD_PREFIX);
}

export function handleUiHostMethod(
	method: string,
	params: Record<string, unknown>,
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
					openLinks: true,
					displayMode: ['inline', 'fullscreen'],
					updateModelContext: true,
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
			return { resultType: 'complete', opened: true, url };
		}
		case 'ui/message':
		case 'ui/update-model-context':
		case 'ui/request-display-mode':
			return { resultType: 'complete', accepted: true };
		default:
			if (method.startsWith('ui/notifications/')) {
				return { resultType: 'complete', acknowledged: true };
			}
			throw { code: -32601, message: `Method not found: ${method}` };
	}
}
