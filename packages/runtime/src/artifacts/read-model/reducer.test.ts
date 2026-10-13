import { describe, expect, it } from 'vitest';
import { createFence, stampEvent } from '../publish/fence.ts';
import { emptySnapshot, reduceArtifactEvents } from './reducer.ts';

const ARTIFACT = 'artifact://tenant/score';
const STREAM = 'flue/v1/artifact/tenant/score/events';

describe('reduceArtifactEvents', () => {
	it('does not apply events after a producer sequence gap', () => {
		const fence = createFence('agentdo:score', 1);
		const prior = emptySnapshot(ARTIFACT, '2026-10-12T00:00:00.000Z');
		stampEvent(fence, {
			eventId: 'evt-1',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: '2026-10-12T00:00:00.500Z',
			semanticRevision: 1,
			payload: { patch: { home: 1 } },
		});
		stampEvent(fence, {
			eventId: 'evt-2',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: '2026-10-12T00:00:00.750Z',
			semanticRevision: 2,
			payload: { patch: { home: 2 } },
		});
		const gapEvent = stampEvent(fence, {
			eventId: 'evt-gap',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: '2026-10-12T00:00:01.000Z',
			semanticRevision: 3,
			payload: { patch: { home: 99 } },
		});
		const reduced = reduceArtifactEvents(prior, [gapEvent], {
			cursor: '0000000000000000_0000000000000064',
			now: '2026-10-12T00:00:02.000Z',
		});
		expect(reduced.gap).toBe(true);
		expect(reduced.applied).toBe(0);
		expect(reduced.snapshot.state.home).toBeUndefined();
	});
});
