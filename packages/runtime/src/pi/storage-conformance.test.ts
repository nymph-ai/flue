import { MemoryStorage } from '@earendil-works/pi-durable';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { describe, expect, it } from 'vitest';

// Smoke test that Pi's own storage conformance suite runs under this
// workspace's vitest. StreamStorage (the storage step) reuses the same entry.
registerStorageConformance({ describe, expect, it }, 'MemoryStorage (Pi reference)', async (use) => {
	const storage = new MemoryStorage();
	try {
		await use(storage);
	} finally {
		await storage.close(BACKGROUND_CONTEXT).catch(() => {});
	}
});
