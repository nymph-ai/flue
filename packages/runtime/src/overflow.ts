import { type AssistantMessage, isContextOverflow } from '@earendil-works/pi-ai';
import { WORKERS_AI_OVERFLOW_MARKER } from './errors.ts';

/**
 * Whether an assistant result is a context-window overflow. pi-ai's
 * classifier, plus the Workers-AI binding marker, so a binding 413 classifies
 * without depending on pi-ai's pattern list — or on its non-overflow
 * precedence (a 413 whose provider body happens to mention "rate limit" must
 * still classify as overflow).
 */
export function isAssistantContextOverflow(
	assistant: AssistantMessage,
	contextWindow: number,
): boolean {
	if (
		assistant.stopReason === 'error' &&
		assistant.errorMessage?.includes(WORKERS_AI_OVERFLOW_MARKER)
	) {
		return true;
	}
	return isContextOverflow(assistant, contextWindow);
}
