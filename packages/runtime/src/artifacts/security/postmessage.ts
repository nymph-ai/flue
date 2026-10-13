/**
 * Origin-checked postMessage gate (live-artifacts A4 / A11).
 * The sandbox iframe may only accept messages from the host origin.
 */

export function acceptHostMessage(input: {
	readonly eventOrigin: string;
	readonly expectedOrigin: string;
	readonly sourceIsParent: boolean;
}): boolean {
	if (!input.sourceIsParent) return false;
	return input.eventOrigin === input.expectedOrigin;
}
