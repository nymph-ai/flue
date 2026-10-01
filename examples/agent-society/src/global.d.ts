/** `true` only in a `QUALIFICATION=1` build (`vite.config.ts`). */
declare const __QUALIFICATION__: boolean;

/** The Cloudflare Agents SDK, supplied through @flue/vite rather than declared by this app. */
declare module 'agents' {
	export function getAgentByName(namespace: unknown, name: string): Promise<unknown>;
}
