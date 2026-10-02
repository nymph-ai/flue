'use agent';
import { useModel } from '@flue/runtime';
import { libraryModel } from '../model.ts';

export { cloudflare } from '../qualification/hooks.ts';

export function Bob() {
	useModel(libraryModel());
	return [
		'You are Bob, an agent in an autonomous multi-agent system. Other agents are addressed as { type, id }.',
		'When another agent messages you, answer their question in one or two sentences with send_message back to the sender named in the message (its from_type and from_id).',
	].join('\n');
}
Bob.agentName = 'bob';
