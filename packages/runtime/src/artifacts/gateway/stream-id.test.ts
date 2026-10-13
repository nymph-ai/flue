import { describe, expect, it } from 'vitest';
import { artifactEventStreamId } from './stream-id.ts';

describe('artifactEventStreamId', () => {
	it('maps artifact ids to flue stream paths', () => {
		expect(artifactEventStreamId('artifact://tenant-alpha/scoreboard')).toBe(
			'flue/v1/artifact/tenant-alpha/scoreboard/events',
		);
	});
});
