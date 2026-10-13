/**
 * Host delivery selection (P22-A10).
 *
 * Same artifact id and stream authority on every host. Hosts that cannot
 * subscribe to Electric receive a static snapshot plus a live link.
 */

export type HostId =
	| 'nymphai-web'
	| 'chatgpt'
	| 'claude'
	| 'notion-embed'
	| 'notion-html'
	| 'obsidian-plugin';

export interface HostDelivery {
	readonly host: HostId;
	readonly mode: 'mcp-apps-live' | 'mcp-apps-snapshot' | 'hosted-embed' | 'static-snapshot';
	readonly liveStream: boolean;
	readonly fallbackUrl?: string;
}

export function resolveHostDelivery(host: HostId, liveUrl: string): HostDelivery {
	switch (host) {
		case 'nymphai-web':
		case 'obsidian-plugin':
			return { host, mode: 'mcp-apps-live', liveStream: true };
		case 'chatgpt':
		case 'claude':
			return { host, mode: 'mcp-apps-snapshot', liveStream: false, fallbackUrl: liveUrl };
		case 'notion-embed':
			return { host, mode: 'hosted-embed', liveStream: false, fallbackUrl: liveUrl };
		case 'notion-html':
			return { host, mode: 'static-snapshot', liveStream: false, fallbackUrl: liveUrl };
	}
}
