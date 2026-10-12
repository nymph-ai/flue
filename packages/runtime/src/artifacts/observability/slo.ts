/**
 * SLI names and numeric targets for live artifacts (P22-A12).
 * These are the contract the dashboards and load scripts measure against.
 * Live burn-rate alerts require a production collector (pending).
 */

export const ARTIFACT_SLOS = {
	freshRenderP95Ms: 800,
	propagationP95Ms: 1500,
	resumeP95Ms: 1000,
	availability: 0.995,
	maxViewersPerArtifact: 5000,
	maxOutboxBatch: 50,
	maxHtmlBytes: 512 * 1024,
} as const;

export const ARTIFACT_SPAN_NAMES = [
	'artifact.publish',
	'artifact.outbox.append',
	'artifact.materialize',
	'artifact.gateway.bootstrap',
	'artifact.browser.paint',
] as const;
