/**
 * live-artifacts A13 scoreboard acceptance gate (hermetic).
 *
 * publish → simulated worker restart → reload ui:// → live Electric patch → revoke.
 */

import { describe, expect, it } from 'vitest';
import { FakeDurableObjectStorage } from '../../cloudflare/do-sqlite-test-support.ts';
import { OperationStore } from '../../mcp-server/operations.ts';
import { appendCreatingMany } from '../../entity/append.ts';
import { McpCapabilityProjection } from '../../mcp-server/projection.ts';
import { InMemoryDurableStreamLog } from '../../streams/memory-log.ts';
import { authorizeArtifactActionAsync } from '../actions/authorize-async.ts';
import {
	OperationPortFabricAdmission,
	wireAutoAdmitGovernedOperations,
} from '../actions/operation-port-admission.ts';
import { issueViewerToken } from '../auth/tokens.ts';
import { MemoryReadGateway } from '../gateway/memory-gateway.ts';
import { MemoryViewerAuthorizationPort } from '../gateway/viewer-auth.ts';
import { RegistryBackedUiResourceReader } from '../persistent-ui-resources.ts';
import { publishReviewedHtmlArtifact } from '../promotion-publish.ts';
import { SqliteProducerFenceStore } from '../publish/sqlite-producer-fence.ts';
import { ContentAddressedBlobStore, MemoryBlobBucket } from '../storage/blob-store.ts';
import { SqliteArtifactRegistry } from '../storage/sqlite-registry.ts';

const SECRET = 'scoreboard-secret';
const TENANT = 'tenant-alpha';
const ARTIFACT = 'artifact://tenant-alpha/scoreboard';
const STREAM = 'flue/v1/artifact/tenant-alpha/scoreboard/events';
const UI_URI = 'ui://tenant-alpha/scoreboard/v1';
const HTML = '<!doctype html><html><body><span id="home">0</span></body></html>';

describe('live-artifacts scoreboard acceptance (hermetic)', () => {
	it('publish, restart registry, reload ui://, live patch, revoke', async () => {
		const storage = new FakeDurableObjectStorage();
		const blobs = new ContentAddressedBlobStore(new MemoryBlobBucket());
		const registryA = new SqliteArtifactRegistry(storage);
		const published = await publishReviewedHtmlArtifact({
			registry: registryA,
			blobs,
			artifactId: ARTIFACT,
			tenantId: TENANT,
			ownerPrincipal: 'user:alice',
			revisionId: 'rev_1',
			uiResourceUri: UI_URI,
			html: HTML,
		});

		const registryB = new SqliteArtifactRegistry(storage);
		const reader = new RegistryBackedUiResourceReader(registryB, blobs);
		const projection = new McpCapabilityProjection({
			uiResourceReader: reader,
		});
		const read = (await projection.handleRequest({
			jsonrpc: '2.0',
			id: 1,
			method: 'resources/read',
			params: {
				uri: UI_URI,
				_meta: {
					'io.modelcontextprotocol/clientCapabilities': {
						extensions: { 'io.modelcontextprotocol/ui': true },
					},
				},
			},
		})) as { result: { contents: Array<{ text: string }> } };
		expect(read.result.contents[0]!.text).toBe(published.html);

		const fenceStore = new SqliteProducerFenceStore(storage);
		const log = new InMemoryDurableStreamLog();
		const liveEvent = fenceStore.stamp({
			producerId: 'agentdo:scoreboard',
			eventId: 'evt-live-1',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: '2026-10-12T01:00:00.000Z',
			semanticRevision: 1,
			payload: { patch: { home: 7 } },
		});
		await appendCreatingMany(log, STREAM, [liveEvent], undefined);

		const auth = new MemoryViewerAuthorizationPort();
		const gateway = new MemoryReadGateway({
			log,
			secret: SECRET,
			streamFor: () => STREAM,
			authorization: auth,
			now: () => 1_700_000_000_000,
			heartbeatMs: 25,
		});
		const token = issueViewerToken(SECRET, {
			artifactId: ARTIFACT,
			tenantId: TENANT,
			principal: 'user:alice',
			tools: ['artifact.score.set'],
			exp: 1_700_000_060_000,
		});
		const boot = await gateway.bootstrap(ARTIFACT, token);
		expect(boot.snapshot.state.home).toBe(7);

		const opPort = new OperationStore();
		wireAutoAdmitGovernedOperations(opPort);
		const admission = new OperationPortFabricAdmission(opPort);
		const allowed = await authorizeArtifactActionAsync({
			claims: {
				artifactId: ARTIFACT,
				tenantId: TENANT,
				principal: 'user:alice',
				tools: ['artifact.score.set'],
				exp: 9,
			},
			artifactId: ARTIFACT,
			tenantId: TENANT,
			toolName: 'artifact.score.set',
			appOnlyTools: [],
			allowedTools: ['artifact.score.set'],
			revoked: false,
			requiresFabricAdmission: true,
			fabricAdmission: admission,
		});
		expect(allowed.allowed).toBe(true);

		auth.revoke(ARTIFACT);
		await expect(gateway.bootstrap(ARTIFACT, token)).rejects.toThrow(/revoked/);

		const fenceAfterRestart = new SqliteProducerFenceStore(storage);
		const replay = fenceAfterRestart.stamp({
			producerId: 'agentdo:scoreboard',
			eventId: 'evt-live-2',
			streamId: STREAM,
			type: 'artifact.state.updated',
			artifactId: ARTIFACT,
			occurredAt: '2026-10-12T01:00:01.000Z',
			semanticRevision: 2,
			payload: { patch: { home: 8 } },
		});
		expect(replay.producerSeq).toBeGreaterThan(liveEvent.producerSeq);
	});
});
