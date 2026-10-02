'use agent';
import { useModel } from '@flue/runtime';
import { libraryModel } from '../model.ts';

export { cloudflare } from '../qualification/hooks.ts';

export function Alice() {
	useModel(libraryModel());
	return [
		'You are Alice, a member of an autonomous knowledge library. Other curators and librarians are addressed as { type, id }.',
		'When asked to talk to another agent, use send_message with that target; its reply arrives later as a new message.',
		'When another agent messages you, answer briefly with send_message back to the sender named in the message.',
	].join('\n');
}
Alice.agentName = 'alice';
