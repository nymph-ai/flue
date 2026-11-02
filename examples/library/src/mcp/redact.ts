/**
 * Secrets never leave the library: not through a route, a tool, the audit
 * log or the Worker's console. A subscriber's delivery secret (OpenAI's
 * webhook signing key) is stored only in mcp_subscriptions, where signing
 * reads it; everything that records or returns a request passes through
 * redactSecrets first.
 */
export const REDACTED = '[redacted]';

const SECRET_KEY = /secret|signature|authorization|password|token|api[-_]?key|capability/i;
const SECRET_QUERY = /([?&](?:secret|token|key|sig|signature)=)[^&#\s"']+/gi;
const WEBHOOK_SECRET = /whsec_[A-Za-z0-9+/=_-]+/g;

function redactString(value: string): string {
	return value.replace(SECRET_QUERY, `$1${REDACTED}`).replace(WEBHOOK_SECRET, REDACTED);
}

/** A copy of `value` with every secret-looking field and string redacted. */
export function redactSecrets<T>(value: T): T {
	return walk(value, 0) as T;
}

function walk(value: unknown, depth: number): unknown {
	if (depth > 32) return REDACTED;
	if (typeof value === 'string') return redactString(value);
	if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? REDACTED : walk(v, depth + 1);
		}
		return out;
	}
	return value;
}

/** A short, non-reversible name for a secret, so a rotation can be seen without the secret. */
export async function secretFingerprint(secret: string | undefined | null): Promise<string | null> {
	if (!secret) return null;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return Array.from(new Uint8Array(digest).slice(0, 4))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** Constant-time bearer check against the Worker's LIBRARY_TOKEN secret. */
export function bearerAuthorized(env: Record<string, unknown> | undefined, header: string | undefined): boolean {
	const token = env?.LIBRARY_TOKEN;
	if (typeof token !== 'string' || token.length === 0) return false;
	const given = header?.replace(/^Bearer\s+/i, '') ?? '';
	const a = new TextEncoder().encode(given);
	const b = new TextEncoder().encode(token);
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}
