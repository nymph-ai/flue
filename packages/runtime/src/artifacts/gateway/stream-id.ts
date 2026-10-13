/** Durable stream path for an artifact's live event log (P22). */

export function artifactSlug(artifactId: string): string {
	const parts = artifactId.replace(/^artifact:\/\//, '').split('/');
	return parts[parts.length - 1] || 'artifact';
}

export function tenantFromArtifactId(artifactId: string): string {
	const parts = artifactId.replace(/^artifact:\/\//, '').split('/');
	if (!parts[0]) throw new Error(`invalid artifact id: ${artifactId}`);
	return parts[0];
}

export function artifactEventStreamId(artifactId: string): string {
	return `flue/v1/artifact/${tenantFromArtifactId(artifactId)}/${artifactSlug(artifactId)}/events`;
}
