/**
 * A deterministic scripted model for the society: a pi-ai provider over the
 * faux model (`fauxProvider`), so every turn still runs the full Pi Durable
 * path — generation tasks, streamed partials, tool rounds, commits — and only
 * the model's choice is scripted.
 *
 * The script reads the newest user turn. A user prompt or another agent's
 * message (a `<signal type="a2a.message" from_type=… from_id=…>` turn) is a
 * list of commands, one per line:
 *
 *   send <type>/<id> <text>        send_message to that agent
 *   spawn <type> <prefix> <n>      n spawn_agent calls, keys <prefix>-0 … <prefix>-(n-1)
 *   observe <stream> [<key> [<from>]]  observe the stream from an offset (default: its
 *                                  start), waking on new items
 *   schedule <delay-ms> <text>     schedule_wake for this agent
 *   codemode record <id>           a Code Mode script calling ops.record({ id })
 *                                  (approval-gated on the steward)
 *   mcp <tool> <arg>               the ops MCP server's tool directly:
 *                                  `mcp deploy <service>`, `mcp echo <text>`
 *   chain <n>                      n publish_event rounds, then an answer
 *   slow <n>                       an answer of n sentences, streamed slowly
 *
 * A message from another agent that starts with "ping" is answered with
 * send_message back to its sender ("ping" becomes "pong"); one that starts
 * with "pong" is acknowledged. Anything else gets a short acknowledgement.
 * After a tool round the script continues the commands still to run, then
 * answers with what the tools said.
 */
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	type Provider,
} from '@earendil-works/pi-ai';

export const SCRIPTED_PROVIDER = 'scripted';
export const SCRIPTED_MODEL = 'society-1';

interface Signal {
	readonly type: string;
	readonly attributes: Record<string, string>;
	readonly body: string;
}

function textOf(message: Message | undefined): string {
	if (!message || message.role === 'system') return '';
	const content = message.content;
	if (typeof content === 'string') return content;
	return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

function unescapeXml(value: string): string {
	return value
		.replaceAll('&quot;', '"')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&');
}

function parseSignal(text: string): Signal | undefined {
	const match = /<signal\s([^>]*)>\n?([\s\S]*?)\n?<\/signal>/.exec(text);
	if (!match) return undefined;
	const attributes: Record<string, string> = {};
	for (const attribute of (match[1] as string).matchAll(/([\w-]+)="([^"]*)"/g)) {
		attributes[attribute[1] as string] = unescapeXml(attribute[2] as string);
	}
	return {
		type: attributes.type ?? '',
		attributes,
		body: unescapeXml((match[2] as string).trim()),
	};
}

type Call = { readonly name: string; readonly args: Record<string, unknown> };

/** The tool calls one command line asks for, or `undefined` when it is not a command. */
function commandCalls(line: string): Call[] | undefined {
	const words = line.trim().split(/\s+/);
	const verb = words[0];
	if (verb === 'send' && words[1]?.includes('/')) {
		const slash = (words[1] as string).indexOf('/');
		return [
			{
				name: 'send_message',
				args: {
					target: {
						type: (words[1] as string).slice(0, slash),
						id: (words[1] as string).slice(slash + 1),
					},
					text: words.slice(2).join(' ') || 'ping',
				},
			},
		];
	}
	if (verb === 'spawn' && words.length >= 4) {
		const count = Math.max(0, Math.min(500, Number(words[3]) || 0));
		return Array.from({ length: count }, (_, index) => ({
			name: 'spawn_agent',
			args: { type: words[1], key: `${words[2]}-${index}` },
		}));
	}
	if (verb === 'observe' && words[1]) {
		return [
			{
				name: 'observe',
				args: {
					key: words[2] ?? 'world',
					stream: words[1],
					...(words[3] ? { from: words[3] } : {}),
					wake: true,
				},
			},
		];
	}
	if (verb === 'codemode' && words[1] === 'record' && words[2]) {
		return [
			{
				name: 'codemode',
				args: { code: `async () => await ops.record({ id: ${JSON.stringify(words[2])} })` },
			},
		];
	}
	if (verb === 'mcp' && words[1] === 'deploy' && words[2]) {
		return [{ name: 'mcp__ops__deploy', args: { service: words[2] } }];
	}
	if (verb === 'mcp' && words[1] === 'echo') {
		return [{ name: 'mcp__ops__echo', args: { text: words.slice(2).join(' ') || 'hello' } }];
	}
	if (verb === 'schedule' && words.length >= 2) {
		return [
			{
				name: 'schedule_wake',
				args: { delay_ms: Number(words[1]) || 0, text: words.slice(2).join(' ') || 'reminder' },
			},
		];
	}
	return undefined;
}

let callCounter = 0;

function toolCalls(calls: readonly Call[], messages: readonly Message[]): AssistantMessage {
	// Ids are unique per conversation position; the counter only breaks ties
	// between calls of one message.
	const base = `call-${messages.length}`;
	return fauxAssistantMessage(
		calls.map((call, index) =>
			fauxToolCall(call.name, call.args as never, {
				id: `${base}-${index}-${(callCounter++).toString(36)}`,
			}),
		),
		{ stopReason: 'toolUse' },
	);
}

/** Decide one model response from the transcript. Pure but for call ids. */
export function respond(messages: readonly Message[]): AssistantMessage {
	const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
	const turn = messages.slice(lastUserIndex + 1);
	const results = turn.filter((message) => message.role === 'toolResult');
	const userText = textOf(messages[lastUserIndex]);
	const signal = parseSignal(userText);
	const body = signal ? signal.body : userText.trim();

	// A message from another agent.
	if (signal && signal.type === 'a2a.message') {
		const from = { type: signal.attributes.from_type, id: signal.attributes.from_id };
		if (results.length > 0) return fauxAssistantMessage(`Replied to ${from.type}/${from.id}.`);
		if (/^ping\b/i.test(body)) {
			return toolCalls(
				[{ name: 'send_message', args: { target: from, text: body.replace(/^ping/i, 'pong') } }],
				messages,
			);
		}
		if (/^pong\b/i.test(body)) {
			return fauxAssistantMessage(`Received "${body}" from ${from.type}/${from.id}.`);
		}
	}

	const lines = body.split('\n').filter((line) => line.trim().length > 0);
	const chain = /^chain\s+(\d+)/.exec(lines[0] ?? '');
	if (chain) {
		const rounds = Number(chain[1]);
		if (results.length < rounds) {
			return toolCalls(
				[
					{
						name: 'publish_event',
						args: { event: { round: results.length + 1, of: rounds } },
					},
				],
				messages,
			);
		}
		return fauxAssistantMessage(`Chain of ${rounds} published.`);
	}
	const slow = /^slow\s+(\d+)/.exec(lines[0] ?? '');
	if (slow) {
		const sentences = Math.max(1, Math.min(200, Number(slow[1])));
		return fauxAssistantMessage(
			Array.from(
				{ length: sentences },
				(_, index) => `Sentence ${index + 1} of a slow answer.`,
			).join(' '),
		);
	}

	// Commands: every command line's calls go out in one assistant message, once.
	const calls = lines.flatMap((line) => commandCalls(line) ?? []);
	if (calls.length > 0 && results.length === 0) return toolCalls(calls, messages);
	if (results.length > 0) {
		const failed = results.filter(
			(result) => result.role === 'toolResult' && result.isError,
		).length;
		return fauxAssistantMessage(
			`Done: ${results.length} tool call(s)${failed ? `, ${failed} failed` : ''}. ${textOf(results.at(-1)).slice(0, 400)}`,
		);
	}
	if (signal?.type === 'a2a.spawn') return fauxAssistantMessage('Spawned and ready.');
	return fauxAssistantMessage(`ack: ${body.slice(0, 80)}`);
}

/** The scripted provider: model `scripted/society-1`. */
export function scriptedProvider(options: { readonly tokensPerSecond?: number } = {}): Provider {
	const faux = fauxProvider({
		provider: SCRIPTED_PROVIDER,
		models: [{ id: SCRIPTED_MODEL, name: 'Society scripted model' }],
		...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {}),
		tokenSize: { min: 4, max: 4 },
	});
	// Every request takes the next queued step, and every step is the same
	// function of its transcript. The queue is refilled long before it runs
	// dry: Durable Objects sharing an isolate share this provider, and a
	// request takes its step before the previous one has run.
	const steps = (count: number) => Array.from({ length: count }, () => step as never);
	const step = (context: { messages: Message[] }) => {
		if (faux.getPendingResponseCount() < 512) faux.appendResponses(steps(1024));
		return respond(context.messages);
	};
	faux.setResponses(steps(1024));
	return faux.provider;
}
