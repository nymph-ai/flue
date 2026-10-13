import { describe, expect, it } from 'vitest';
import { FakeDurableObjectStorage } from '../../cloudflare/do-sqlite-test-support.ts';
import { SqliteProducerFenceStore } from './sqlite-producer-fence.ts';

const STREAM = 'flue/v1/artifact/tenant-alpha/scoreboard/events';
const ARTIFACT = 'artifact://tenant-alpha/scoreboard';

describe('SqliteProducerFenceStore', () => {
	it('persists epoch and seq across store restarts', () => {
		const storage = new FakeDurableObjectStorage();
		const a = new SqliteProducerFenceStore(storage);
		const first = a.stamp({
			producerId: 'agentdo:scoreboard',
			eventId: 'evt-1',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: '2026-10-12T00:00:00.000Z',
			semanticRevision: 1,
			payload: { patch: { home: 1 } },
		});
		const b = new SqliteProducerFenceStore(storage);
		const second = b.stamp({
			producerId: 'agentdo:scoreboard',
			eventId: 'evt-2',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: '2026-10-12T00:00:01.000Z',
			semanticRevision: 2,
			payload: { patch: { home: 2 } },
		});
		expect(second.producerSeq).toBe(first.producerSeq + 1);
		expect(second.producerEpoch).toBe(first.producerEpoch);
	});
});
