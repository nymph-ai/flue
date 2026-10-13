/**
 * Immutable content-addressed blob store (P22-A3).
 *
 * The registry stores digests. Bytes live here (R2 in production, memory in
 * tests). A second put of the same digest is a no-op; different bytes for the
 * same digest are rejected. Digests are always verified against bytes on put/get.
 */

import { createHash } from 'node:crypto';

export interface BlobBucket {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: Uint8Array): Promise<void>;
}

export class ImmutableBlobConflict extends Error {
	constructor(digest: string) {
		super(`blob ${digest} already stored with different bytes`);
		this.name = 'ImmutableBlobConflict';
	}
}

export class BlobDigestMismatch extends Error {
	constructor(digest: string) {
		super(`blob bytes do not match digest ${digest}`);
		this.name = 'BlobDigestMismatch';
	}
}

export function sha256Digest(bytes: Uint8Array): string {
	const h = createHash('sha256');
	h.update(bytes);
	return `sha256:${h.digest('hex')}`;
}

export class ContentAddressedBlobStore {
	constructor(private readonly bucket: BlobBucket) {}

	async put(digest: string, bytes: Uint8Array): Promise<void> {
		const computed = sha256Digest(bytes);
		if (digest !== computed) {
			throw new BlobDigestMismatch(digest);
		}
		if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
			throw new Error(`refusing non-digest key ${digest}`);
		}
		const existing = await this.bucket.get(digest);
		if (existing) {
			const prev = new Uint8Array(await existing.arrayBuffer());
			if (!bytesEqual(prev, bytes)) throw new ImmutableBlobConflict(digest);
			return;
		}
		await this.bucket.put(digest, bytes);
	}

	async get(digest: string): Promise<Uint8Array | null> {
		const existing = await this.bucket.get(digest);
		if (!existing) return null;
		const bytes = new Uint8Array(await existing.arrayBuffer());
		if (sha256Digest(bytes) !== digest) {
			throw new BlobDigestMismatch(digest);
		}
		return bytes;
	}
}

export class MemoryBlobBucket implements BlobBucket {
	readonly objects = new Map<string, Uint8Array>();

	async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
		const bytes = this.objects.get(key);
		if (!bytes) return null;
		return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
	}

	async put(key: string, value: Uint8Array): Promise<void> {
		this.objects.set(key, value.slice());
	}
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}
