/**
 * R2-backed immutable blob bucket for artifact bundles (P22 production).
 */

import type { BlobBucket } from './blob-store.ts';

export interface R2BlobBinding {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: ArrayBuffer | Uint8Array): Promise<void>;
}

export class R2BlobBucket implements BlobBucket {
	constructor(private readonly bucket: R2BlobBinding) {}

	async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
		return this.bucket.get(key);
	}

	async put(key: string, value: Uint8Array): Promise<void> {
		await this.bucket.put(key, value);
	}
}
