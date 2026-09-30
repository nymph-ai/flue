/**
 * Flue agent configuration → Pi Durable conversation configuration
 * (PI_UPGRADE_PLAN.md §1 `compaction.ts` row, §7 step 6).
 *
 * The compaction defaults moved here from `compaction.ts`, which Pi's
 * `CompactionTask` replaces: Flue keeps its model-aware reserve (capped at the
 * model's max output, clamped for tiny windows) and its 8k preserved tail, and
 * never runs background compaction — Flue had none — so `backgroundTokens` is
 * always 0.
 */
import type { CompactionPolicy, ModelRef } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai';
import type { CompactionConfig, ThinkingLevel } from '../types.ts';

const DEFAULT_RESERVE_TOKENS = 20_000;
const DEFAULT_KEEP_RECENT_TOKENS = 8_000;

/** Split a Flue `provider-id/model-id` specifier into a Pi `ModelRef`. */
export function parseModelSpecifier(specifier: string): ModelRef {
	const slash = specifier.indexOf('/');
	if (slash <= 0 || slash === specifier.length - 1) {
		throw new Error(
			`[flue] Invalid model specifier "${specifier}". ` +
				'Use the "provider-id/model-id" format (e.g. "anthropic/claude-haiku-4-5").',
		);
	}
	return { provider: specifier.slice(0, slash), modelId: specifier.slice(slash + 1) };
}

/**
 * Flue's `ThinkingLevel` and Pi's `ModelThinkingLevel` are the same union
 * (`off` … `max`). Unset maps to Flue's historical default, `medium`.
 */
export function thinkingLevelFor(level: ThinkingLevel | undefined): ThinkingLevel {
	return level ?? 'medium';
}

/** Flue's model-aware compaction defaults (formerly `deriveCompactionDefaults`). */
export function flueCompactionDefaults(input: {
	contextWindow: number;
	maxTokens: number;
}): { reserveTokens: number; keepRecentTokens: number } {
	const reserveCap = input.maxTokens > 0 ? input.maxTokens : DEFAULT_RESERVE_TOKENS;
	let reserveTokens = Math.min(DEFAULT_RESERVE_TOKENS, reserveCap);
	if (input.contextWindow > 0 && reserveTokens * 2 >= input.contextWindow) {
		reserveTokens = Math.max(1024, Math.floor(input.contextWindow / 3));
	}
	return { reserveTokens, keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS };
}

/**
 * Map `useModel({ compaction })` onto a Pi `CompactionPolicy`. `false` keeps
 * overflow recovery and manual `compact()` (Pi ignores `enabled` for both)
 * and disables threshold compaction, exactly Flue's contract. `model` (a
 * summarizer override) has no Pi policy field; `compactionSummarizerFor`
 * reports it so the host can decide how to honour it.
 */
export function compactionPolicyFor(
	config: false | CompactionConfig | undefined,
	model: { contextWindow: number; maxTokens: number } | undefined,
): CompactionPolicy {
	const defaults = flueCompactionDefaults(model ?? { contextWindow: 0, maxTokens: 0 });
	const overrides = config === false || config === undefined ? {} : config;
	return {
		enabled: config !== false,
		reserveTokens: overrides.reserveTokens ?? defaults.reserveTokens,
		keepRecentTokens: overrides.keepRecentTokens ?? defaults.keepRecentTokens,
		backgroundTokens: 0,
	};
}

/** The summarizer override of a compaction config, if any. */
export function compactionSummarizerFor(
	config: false | CompactionConfig | undefined,
): ModelRef | undefined {
	return config && config.model !== undefined ? parseModelSpecifier(config.model) : undefined;
}

/** Context-window metadata for the compaction defaults, when `models` knows the model. */
export function modelLimits(
	models: Models,
	model: ModelRef | undefined,
): { contextWindow: number; maxTokens: number } | undefined {
	if (model === undefined) return undefined;
	const resolved = models.getModel(model.provider, model.modelId);
	return resolved === undefined
		? undefined
		: { contextWindow: resolved.contextWindow ?? 0, maxTokens: resolved.maxTokens ?? 0 };
}
