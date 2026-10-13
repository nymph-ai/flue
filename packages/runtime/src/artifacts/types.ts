/** Shared artifact read-model types (align with nymphai live-artifacts A1 schemas). */

export interface ArtifactReadModelSnapshot {
	schemaVersion: 1;
	artifactId: string;
	readModelRevision: number;
	state: Record<string, unknown>;
	cursor: string;
	materializedAt: string;
	lastEventId?: string;
}
