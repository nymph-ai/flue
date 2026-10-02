/**
 * The agent conversation read routes (`history` and `updates` views, HEAD,
 * attachment bytes) over a {@link ConversationProjectionSource}: the Pi
 * projection cached over Pi storage (`pi/conversation-cache.ts`), or a
 * pre-upgrade record stream (`legacy/conversation-source.ts`). The wire is
 * the one `@flue/sdk` speaks, unchanged.
 */
import type {
	AgentConversationSnapshot,
	ConversationStreamCheckpointChunk,
} from '../conversation-public.ts';
import {
	AttachmentNotFoundError,
	HistoryCursorNotFoundError,
	InvalidRequestError,
	StreamNotFoundError,
	StreamOffsetGoneError,
	toHttpResponse,
} from '../errors.ts';
import { legacyConversationSource } from '../legacy/conversation-source.ts';
import { compareOffsets, isResumeOffset } from '../streams/offset.ts';
import type { AttachmentStore } from './attachment-store.ts';
import {
	applyHistoryWindow,
	applyResetWindow,
	parseHistoryWindow,
	parseResetWindow,
	type ResetWindow,
} from './conversation-history-window.ts';
import type {
	ConversationProjectionSource,
	ConversationRead,
	ResetWindowProjector,
} from './conversation-source.ts';
import type { ConversationStreamStore } from './conversation-stream-store.ts';

const SECURITY_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Cross-Origin-Resource-Policy': 'cross-origin',
};
const SSE_HEARTBEAT_MS = 15_000;

/** The attachment scope every Pi-era attachment of an instance is stored under. */
export const ATTACHMENT_CONVERSATION_SCOPE = 'root';

/** A projection source, or (pre-upgrade streams) a record store and its path. */
export type ConversationReadTarget =
	| { readonly source: ConversationProjectionSource }
	| { readonly store: ConversationStreamStore; readonly path: string };

function sourceOf(target: ConversationReadTarget): ConversationProjectionSource {
	return 'source' in target ? target.source : legacyConversationSource(target.store, target.path);
}

function pathOf(target: ConversationReadTarget): string {
	return 'path' in target ? target.path : 'conversation';
}

export async function handleAgentConversationRead(
	options: ConversationReadTarget & { readonly request: Request },
): Promise<Response> {
	const url = new URL(options.request.url);
	const view = url.searchParams.get('view') ?? 'history';
	const source = sourceOf(options);
	if (view === 'history') return historyResponse(source, pathOf(options), options.request);
	if (view === 'updates') return updatesResponse(source, pathOf(options), options.request);
	return errorResponse(
		new InvalidRequestError({ reason: 'Invalid agent conversation view. Use history or updates.' }),
	);
}

/**
 * Serves the bytes of one attachment referenced by the default conversation.
 * Attachments of task/action child conversations are never served here. The
 * byte content is immutable (digest-keyed), hence the long-lived private
 * cache.
 */
export async function handleAgentAttachmentRead(options: {
	source: ConversationProjectionSource;
	attachmentStore: AttachmentStore;
	/** The attachment store key of the instance (`agentStreamPath`). */
	streamPath: string;
	attachmentId: string;
}): Promise<Response> {
	const head = await options.source.head();
	if (!head.snapshot) return errorResponse(new StreamNotFoundError({ path: options.streamPath }));
	const stored = await options.attachmentStore.get({
		streamPath: options.streamPath,
		conversationId: ATTACHMENT_CONVERSATION_SCOPE,
		attachmentId: options.attachmentId,
	});
	if (!stored)
		return errorResponse(new AttachmentNotFoundError({ attachmentId: options.attachmentId }));
	return new Response(stored.bytes, {
		headers: {
			'content-type': stored.attachment.mimeType,
			'content-length': String(stored.attachment.size),
			'content-disposition': 'inline',
			'cache-control': 'private, max-age=31536000, immutable',
			// The mime type is uploader-controlled, so a malicious "image" could be
			// served as text/html. `sandbox` neutralizes script/HTML execution on
			// direct navigation without affecting <img>/<a> sub-resource loads.
			'content-security-policy': 'sandbox',
			...SECURITY_HEADERS,
		},
	});
}

export async function handleAgentConversationHead(
	target: ConversationProjectionSource | ConversationStreamStore,
	path?: string,
): Promise<Response> {
	const source =
		'meta' in target && typeof target.meta === 'function'
			? (target as ConversationProjectionSource)
			: legacyConversationSource(target as ConversationStreamStore, path ?? '');
	const meta = await source.meta();
	if (!meta) return headError(new StreamNotFoundError({ path: path ?? 'conversation' }));
	return new Response(null, {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'Stream-Next-Offset': meta.nextOffset,
			'Stream-Up-To-Date': 'true',
			...SECURITY_HEADERS,
		},
	});
}

async function historyResponse(
	source: ConversationProjectionSource,
	path: string,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	if (
		url.searchParams.has('offset') ||
		url.searchParams.has('tail') ||
		url.searchParams.has('live')
	) {
		return errorResponse(
			new InvalidRequestError({
				reason: 'History reads do not accept offset, tail, or live parameters.',
			}),
		);
	}
	const window = parseHistoryWindow(url);
	if (window instanceof InvalidRequestError) return errorResponse(window);
	const meta = await source.meta();
	if (!meta) return errorResponse(new StreamNotFoundError({ path }));
	const head = await source.head();
	const snapshot = head.snapshot ? { ...head.snapshot, offset: head.offset } : undefined;
	if (!snapshot) return errorResponse(new StreamNotFoundError({ path }));
	let windowed: ReturnType<typeof applyHistoryWindow>;
	try {
		windowed =
			window.kind === 'full'
				? snapshot
				: applyHistoryWindow(snapshot, window, {
						incarnation: head.incarnation,
						liveTargets: head.liveTargets,
					});
	} catch (error) {
		if (error instanceof HistoryCursorNotFoundError) return errorResponse(error);
		throw error;
	}
	// An older page is not a checkpoint: no offset, no incarnation.
	if (!('offset' in windowed)) {
		return Response.json(windowed, {
			headers: { 'cache-control': 'no-store', ...SECURITY_HEADERS },
		});
	}
	// The projection is meta-free; the route stamps the stream's generation
	// identity so `observe()` can detect a reset-and-regrown stream mid-follow.
	return Response.json(
		{ ...windowed, incarnation: head.incarnation } satisfies AgentConversationSnapshot,
		{
			headers: {
				'cache-control': 'no-store',
				'Stream-Next-Offset': snapshot.offset,
				'Stream-Up-To-Date': 'true',
				...SECURITY_HEADERS,
			},
		},
	);
}

async function updatesResponse(
	source: ConversationProjectionSource,
	path: string,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	if (url.searchParams.has('tail')) {
		return errorResponse(new InvalidRequestError({ reason: 'Update streams do not accept tail.' }));
	}
	const offset = singleOffset(url);
	if (offset instanceof Response) return offset;
	const live = liveMode(url);
	if (live instanceof Response) return live;
	const resetWindow = parseResetWindow(url);
	if (resetWindow instanceof InvalidRequestError) return errorResponse(resetWindow);
	const meta = await source.meta();
	if (!meta) return errorResponse(new StreamNotFoundError({ path }));
	// Reads start strictly after the requested offset, so equal-to-head is a
	// legal empty wait; strictly beyond the head is a resume checkpoint that
	// no longer exists (a store reset and regrown shorter): a structured 416,
	// before any response commits. Offsets are opaque and ordered
	// lexicographically (PROTOCOL §8).
	if (compareOffsets(offset, meta.nextOffset) > 0) {
		return errorResponse(new StreamOffsetGoneError({ path, offset, nextOffset: meta.nextOffset }));
	}
	// Every wire response leads with a stream-checkpoint chunk carrying the
	// stream's generation identity, in-band, where the SDK can see it.
	const checkpoint: ConversationStreamCheckpointChunk = {
		type: 'stream-checkpoint',
		incarnation: meta.incarnation,
	};
	const windowReset = resetWindowProjector(resetWindow, meta.incarnation);
	if (live === 'sse') {
		return sseResponse(source, offset, checkpoint, request.signal, windowReset);
	}
	const read = await source.read(offset, {
		...(live === 'long-poll' ? { live: 'long-poll' as const } : {}),
		signal: request.signal,
		...(windowReset ? { resetWindow: windowReset } : {}),
	});
	if (read === 'aborted') return new Response(null, { status: 499, headers: SECURITY_HEADERS });
	return dsJsonResponse([checkpoint, ...read.chunks], read);
}

/**
 * A bounded observation's updates stream (`from` / `limit`) receives
 * `conversation-reset` snapshots cut to its window server-side, so a reset
 * does not re-send the whole transcript.
 */
function resetWindowProjector(
	window: ResetWindow,
	incarnation: string,
): ResetWindowProjector | undefined {
	if (!window.from && window.limit === undefined) return undefined;
	return (snapshot, liveTargets) =>
		applyResetWindow(snapshot, window, { incarnation, liveTargets });
}

function dsJsonResponse(items: unknown[], read: ConversationRead): Response {
	return Response.json(items, {
		headers: {
			'cache-control': 'no-store',
			'Stream-Next-Offset': read.nextOffset,
			...(read.upToDate ? { 'Stream-Up-To-Date': 'true' } : {}),
			...SECURITY_HEADERS,
		},
	});
}

function sseResponse(
	source: ConversationProjectionSource,
	offset: string,
	checkpoint: ConversationStreamCheckpointChunk,
	signal: AbortSignal,
	windowReset: ResetWindowProjector | undefined,
): Response {
	const encoder = new TextEncoder();
	let active = true;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const stop = new AbortController();
	const onAbort = () => {
		active = false;
		stop.abort();
	};
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			// One checkpoint per SSE connection, as the first data frame; every
			// reconnect is a fresh server connection, which re-delivers it.
			controller.enqueue(encoder.encode(`event: data\ndata:${JSON.stringify([checkpoint])}\n\n`));
			heartbeat = setInterval(() => {
				if (active) controller.enqueue(encoder.encode(': heartbeat\n\n'));
			}, SSE_HEARTBEAT_MS);
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
			let currentOffset = offset;
			let first = true;
			try {
				while (active) {
					const read = await source.read(currentOffset, {
						...(first ? {} : { live: 'long-poll' as const }),
						signal: stop.signal,
						...(windowReset ? { resetWindow: windowReset } : {}),
					});
					first = false;
					if (read === 'aborted' || !active) break;
					if (read.chunks.length > 0) {
						controller.enqueue(
							encoder.encode(`event: data\ndata:${JSON.stringify(read.chunks)}\n\n`),
						);
					}
					currentOffset = read.nextOffset;
					const control = {
						streamNextOffset: currentOffset,
						...(read.upToDate ? { upToDate: true } : {}),
					};
					controller.enqueue(encoder.encode(`event: control\ndata:${JSON.stringify(control)}\n\n`));
				}
			} catch (error) {
				if (active) controller.error(error);
				return;
			} finally {
				active = false;
				if (heartbeat) clearInterval(heartbeat);
				signal.removeEventListener('abort', onAbort);
			}
			controller.close();
		},
		cancel() {
			active = false;
			stop.abort();
			if (heartbeat) clearInterval(heartbeat);
		},
	});
	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			...SECURITY_HEADERS,
		},
	});
}

function singleOffset(url: URL): string | Response {
	const offsets = url.searchParams.getAll('offset');
	if (offsets.length !== 1) {
		return errorResponse(new InvalidRequestError({ reason: 'Exactly one offset is required.' }));
	}
	const offset = offsets[0] as string;
	if (!isResumeOffset(offset)) {
		return errorResponse(new InvalidRequestError({ reason: 'Invalid offset format.' }));
	}
	return offset;
}

function liveMode(url: URL): 'long-poll' | 'sse' | null | Response {
	const live = url.searchParams.get('live');
	if (live === null) return null;
	if (live === 'long-poll' || live === 'sse') return live;
	return errorResponse(
		new InvalidRequestError({ reason: 'Invalid live mode. Use long-poll or sse.' }),
	);
}

function errorResponse(
	error:
		| InvalidRequestError
		| StreamNotFoundError
		| StreamOffsetGoneError
		| AttachmentNotFoundError
		| HistoryCursorNotFoundError,
): Response {
	return toHttpResponse(error);
}

function headError(error: StreamNotFoundError): Response {
	const response = toHttpResponse(error);
	return new Response(null, { status: response.status, headers: response.headers });
}
