/**
 * Scoped viewer credentials for artifact reads and app actions (live-artifacts A7).
 * HMAC-SHA256 over a JSON body. No token is embedded in HTML bundles.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ViewerClaims {
	readonly artifactId: string;
	readonly tenantId: string;
	readonly principal: string;
	readonly tools: readonly string[];
	readonly exp: number;
}

export function issueViewerToken(secret: string, claims: ViewerClaims): string {
	const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
	const sig = createHmac('sha256', secret).update(body).digest('base64url');
	return `${body}.${sig}`;
}

export function verifyViewerToken(secret: string, token: string, nowMs: number): ViewerClaims | null {
	const [body, sig] = token.split('.');
	if (!body || !sig) return null;
	const expected = createHmac('sha256', secret).update(body).digest('base64url');
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	let claims: ViewerClaims;
	try {
		claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ViewerClaims;
	} catch {
		return null;
	}
	if (claims.exp <= nowMs) return null;
	return claims;
}
