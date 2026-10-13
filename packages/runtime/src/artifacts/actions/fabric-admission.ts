/**
 * Fabric-governed effect admission (P22-A7).
 *
 * Callers must not pass an unverified fabricAdmitted flag. Admission is decided
 * here from an injected verifier that talks to Fabric / OperationPort policy.
 */

export interface FabricAdmissionVerifier {
	isAdmitted(input: {
		artifactId: string;
		tenantId: string;
		toolName: string;
		principal: string;
	}): Promise<boolean> | boolean;
}

export async function verifyFabricAdmission(
	verifier: FabricAdmissionVerifier | undefined,
	input: {
		artifactId: string;
		tenantId: string;
		toolName: string;
		principal: string;
	},
): Promise<boolean> {
	if (!verifier) return false;
	return verifier.isAdmitted(input);
}
