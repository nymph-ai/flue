/**
 * Names of the Pi tools `entity/tools-facet.ts` registers. The registry
 * bridge offers them to every conversation once registered, and reserves
 * them against custom tools of the same name.
 */
export const ENTITY_TOOL_NAMES = [
	'send_message',
	'publish_event',
	'observe',
	'spawn_agent',
	'schedule_wake',
	'answer_question',
] as const;

export type EntityToolName = (typeof ENTITY_TOOL_NAMES)[number];
