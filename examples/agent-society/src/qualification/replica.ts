/**
 * `QualReplica` — a scratch Durable Object for live qualification, compiled
 * in only by a `QUALIFICATION=1` build:
 *
 * - `rebuild(entity, lastSeq)`: replay an entity's Pi log from Electric into
 *   this object's empty SQLite (what a brand-new Durable Object does) and
 *   return digests of every Pi read, to compare with the live instance's.
 * - `producerProbe(path)`: the Durable Streams producer fences, directly
 *   against the deployed server: a retry is a duplicate, a gap is reported,
 *   an older epoch is fenced.
 * - `splitBrain(entity)`: become a second writer of an entity's Pi log (a
 *   fresh database rebuilt from the log, so a higher producer epoch) and
 *   commit once, so the original writer's next publish is fenced.
 *
 * Every call starts and ends with an empty object: it holds nothing between
 * calls, and reads/writes only what the call names.
 */
import { DurableObject } from 'cloudflare:workers';
import {
	configuredStreamsLog,
	digestSnapshot,
	type EntityAddress,
	piLogPath,
	qualificationContext,
	readPiLog,
	rebuildAndSnapshot,
	splitBrainCommit,
} from '@flue/runtime/qualification';

export class QualReplica extends DurableObject<Record<string, unknown>> {
	#log() {
		const log = configuredStreamsLog(this.env);
		if (!log) throw new Error('FLUE_STREAMS_URL is not configured');
		return log;
	}

	async rebuild(entity: EntityAddress, lastSeq: number): Promise<Record<string, unknown>> {
		await this.ctx.storage.deleteAll();
		try {
			const started = Date.now();
			const { snapshot, rebuiltSeq } = await rebuildAndSnapshot({
				storage: this.ctx.storage as never,
				log: this.#log(),
				entity,
				lastSeq,
			});
			const digests = await digestSnapshot(snapshot);
			return { rebuiltSeq, digest: digests.digest, keys: digests.keys, ms: Date.now() - started };
		} finally {
			await this.ctx.storage.deleteAll();
		}
	}

	/** Envelope seqs on an entity's Pi log: each seq once, contiguous from 1, is what "no duplicate commit" means. */
	async logSeqs(entity: EntityAddress): Promise<Record<string, unknown>> {
		const { envelopes, tail } = await readPiLog(this.#log(), piLogPath(entity));
		const seqs = envelopes.map((envelope) => envelope.seq);
		const duplicates = seqs.filter((seq, index) => seqs.indexOf(seq) !== index);
		const contiguous = seqs.every((seq, index) => seq === index + 1);
		const epochs = [...new Set(envelopes.map((envelope) => (envelope as { epoch?: number }).epoch ?? null))];
		return { count: seqs.length, last: seqs.at(-1) ?? 0, duplicates, contiguous, epochs, tail };
	}

	async producerProbe(path: string): Promise<Record<string, unknown>> {
		const log = this.#log();
		await log.ensure(path);
		const producer = `qual-probe-${crypto.randomUUID().slice(0, 8)}`;
		const append = (epoch: number, seq: number, streamSeq: string, body: unknown) =>
			log.append(path, {
				messages: [body],
				producer: { id: producer, epoch, seq },
				streamSeq,
			});
		const steps: Record<string, unknown>[] = [];
		const record = async (label: string, run: () => Promise<unknown>) => {
			try {
				steps.push({ step: label, outcome: await run() });
			} catch (error) {
				steps.push({ step: label, error: error instanceof Error ? error.message : String(error) });
			}
		};
		await record('first append (epoch 0, seq 0)', () => append(0, 0, '0000000000000001', { n: 1 }));
		await record('retry of the same append', () => append(0, 0, '0000000000000001', { n: 1 }));
		await record('next append (epoch 0, seq 1)', () => append(0, 1, '0000000000000002', { n: 2 }));
		await record('gap (epoch 0, seq 5)', () => append(0, 5, '0000000000000003', { n: 3 }));
		await record('new writer (epoch 1, seq 0)', () => append(1, 0, '0000000000000003', { n: 3 }));
		await record('older writer after it (epoch 0, seq 2)', () =>
			append(0, 2, '0000000000000004', { n: 4 }),
		);
		await record('replay of a landed commit by the new writer (epoch 1, seq 1, Stream-Seq 2)', () =>
			append(1, 1, '0000000000000002', { n: 2 }),
		);
		const messages: unknown[] = [];
		let offset = '-1';
		for (;;) {
			const batch = await log.read(path, offset as never);
			messages.push(...batch.messages);
			offset = batch.nextOffset;
			if (batch.upToDate || batch.messages.length === 0) break;
		}
		return { path, producer, steps, messages };
	}

	async splitBrain(entity: EntityAddress): Promise<Record<string, unknown>> {
		await this.ctx.storage.deleteAll();
		try {
			return await splitBrainCommit({
				storage: this.ctx.storage as never,
				log: this.#log(),
				entity,
				context: qualificationContext,
			});
		} finally {
			await this.ctx.storage.deleteAll();
		}
	}
}
