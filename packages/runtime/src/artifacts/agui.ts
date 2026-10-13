/**
 * Flue semantic events → AG-UI events (live-artifacts A8).
 *
 * Deterministic, typed mapping. CopilotKit consumes these; it does not own
 * a second agent or event log. Artifact identity is independent of thread id.
 */

export type AgUiEvent =
	| { readonly type: 'TEXT_MESSAGE_CONTENT'; readonly threadId: string; readonly delta: string }
	| { readonly type: 'TOOL_CALL_START'; readonly threadId: string; readonly toolCallId: string; readonly toolName: string }
	| { readonly type: 'TOOL_CALL_RESULT'; readonly threadId: string; readonly toolCallId: string; readonly result: unknown }
	| { readonly type: 'TOOL_CALL_END'; readonly threadId: string; readonly toolCallId: string; readonly cancelled: boolean }
	| { readonly type: 'RUN_ERROR'; readonly threadId: string; readonly message: string }
	| { readonly type: 'STATE_SNAPSHOT'; readonly threadId: string; readonly artifactId: string; readonly snapshot: unknown };

export interface FlueProjectionEvent {
	readonly kind: 'message' | 'tool-start' | 'tool-result' | 'tool-cancel' | 'error' | 'artifact-snapshot';
	readonly threadId: string;
	readonly artifactId?: string;
	readonly text?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly result?: unknown;
	readonly message?: string;
	readonly snapshot?: unknown;
}

export function toAgUi(event: FlueProjectionEvent): AgUiEvent {
	switch (event.kind) {
		case 'message':
			return { type: 'TEXT_MESSAGE_CONTENT', threadId: event.threadId, delta: event.text ?? '' };
		case 'tool-start':
			return {
				type: 'TOOL_CALL_START',
				threadId: event.threadId,
				toolCallId: required(event.toolCallId, 'toolCallId'),
				toolName: required(event.toolName, 'toolName'),
			};
		case 'tool-result':
			return {
				type: 'TOOL_CALL_RESULT',
				threadId: event.threadId,
				toolCallId: required(event.toolCallId, 'toolCallId'),
				result: event.result,
			};
		case 'tool-cancel':
			return {
				type: 'TOOL_CALL_END',
				threadId: event.threadId,
				toolCallId: required(event.toolCallId, 'toolCallId'),
				cancelled: true,
			};
		case 'error':
			return { type: 'RUN_ERROR', threadId: event.threadId, message: event.message ?? 'error' };
		case 'artifact-snapshot':
			return {
				type: 'STATE_SNAPSHOT',
				threadId: event.threadId,
				artifactId: required(event.artifactId, 'artifactId'),
				snapshot: event.snapshot,
			};
	}
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`AG-UI mapping missing ${name}`);
	return value;
}
