/**
 * Durable producer fence in DO SQLite (P22-A6).
 */

import type { DurableObjectSqliteStorage } from '../../cloudflare/do-sqlite-database.ts';
import { createFence, stampEvent, type FencedEvent, type ProducerFence } from './fence.ts';

export class SqliteProducerFenceStore {
	constructor(private readonly storage: DurableObjectSqliteStorage) {
		storage.sql.exec(`CREATE TABLE IF NOT EXISTS p22_producer_fence (
			producer_id TEXT PRIMARY KEY,
			epoch INTEGER NOT NULL,
			seq INTEGER NOT NULL
		)`);
	}

	load(producerId: string): ProducerFence {
		const rows = this.storage.sql
			.exec('SELECT epoch, seq FROM p22_producer_fence WHERE producer_id = ?', producerId)
			.toArray();
		const row = rows[0];
		if (!row) return createFence(producerId, 1);
		return { producerId, epoch: Number(row.epoch), seq: Number(row.seq) };
	}

	save(fence: ProducerFence): void {
		this.storage.sql.exec(
			`INSERT INTO p22_producer_fence (producer_id, epoch, seq) VALUES (?, ?, ?)
			 ON CONFLICT(producer_id) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq`,
			fence.producerId,
			fence.epoch,
			fence.seq,
		);
	}

	stamp(input: {
		readonly producerId: string;
		readonly eventId: string;
		readonly streamId: string;
		readonly type: string;
		readonly artifactId: string;
		readonly occurredAt: string;
		readonly semanticRevision: number;
		readonly payload: Record<string, unknown>;
	}): FencedEvent {
		const fence = this.load(input.producerId);
		const event = stampEvent(fence, input);
		this.save(fence);
		return event;
	}

	bumpEpoch(producerId: string): ProducerFence {
		const fence = this.load(producerId);
		fence.epoch += 1;
		fence.seq = 0;
		this.save(fence);
		return fence;
	}
}
