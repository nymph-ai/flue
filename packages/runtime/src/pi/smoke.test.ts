import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { expect, it } from 'vitest';

const context = BACKGROUND_CONTEXT;

it('runs one faux turn through a Pi Durable harness', async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage('hello')]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
	const root = await harness.root(context);
	await root.setModel({ provider: 'faux', modelId: 'faux-1' }, context);
	const submission = await root.submit({ type: 'input', content: 'hi', requestId: 'r1' }, context);
	const settled = await submission.wait(context);
	expect(settled.status).toBe('done');
	await harness.close(context);
});
