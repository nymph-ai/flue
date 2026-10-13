declare global {
	interface Env {
		ARTIFACT_HUB: DurableObjectNamespace;
		ARTIFACT_BLOBS: R2Bucket;
		FLUE_STREAMS: Fetcher;
		FLUE_STREAMS_URL: string;
		FLUE_STREAMS_JWKS_URL?: string;
		FLUE_STREAMS_TOKEN?: string;
		LIVE_ARTIFACTS_VIEWER_TOKEN_SECRET: string;
	}
}

export {};
