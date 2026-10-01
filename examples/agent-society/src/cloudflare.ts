/**
 * Non-HTTP Worker exports, re-exported from the generated Worker entry.
 *
 * `QualReplica` is the qualification build's scratch Durable Object
 * (`qualification/replica.ts`). Its class is declared in every build because
 * wrangler's migrations name it; outside a `QUALIFICATION=1` build it is an
 * inert object that refuses every call.
 */
import { DurableObject } from 'cloudflare:workers';
import { QualReplica as QualificationReplica } from './qualification/replica.ts';

class InertReplica extends DurableObject {
	fetch(): Response {
		return new Response('qualification is not compiled into this build', { status: 404 });
	}
}

export const QualReplica = __QUALIFICATION__ ? QualificationReplica : InertReplica;
