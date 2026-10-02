/**
 * HTTP routes for the Autonomous Knowledge Library Obsidian Vault.
 */
import { Hono } from 'hono';
import { LibraryVault, type R2BucketLike } from './storage.ts';
import type { OKFStoryNote } from './types.ts';

// Shared instance across worker isolate
let defaultVault: LibraryVault | null = null;

export function getOrCreateVault(env?: Record<string, unknown>): LibraryVault {
	if (!defaultVault) {
		const r2 = env?.LIBRARY_VAULT as R2BucketLike | undefined;
		defaultVault = new LibraryVault(r2);
	}
	return defaultVault;
}

export function createWikiRouter(getVault?: (env: Record<string, unknown>) => LibraryVault) {
	const wiki = new Hono<{ Bindings: Record<string, unknown> }>();

	const resolveVault = (env: Record<string, unknown>) =>
		getVault ? getVault(env) : getOrCreateVault(env);

	// Root / Index
	wiki.get('/', async (c) => {
		const vault = resolveVault(c.env);
		const index = await vault.getNote('index.md');
		if (!index) {
			const rebuilt = await vault.rebuildIndex();
			return c.text(rebuilt, 200, { 'content-type': 'text/markdown; charset=utf-8' });
		}
		return c.text(index, 200, { 'content-type': 'text/markdown; charset=utf-8' });
	});

	wiki.get('/index.md', async (c) => {
		const vault = resolveVault(c.env);
		const index = (await vault.getNote('index.md')) ?? (await vault.rebuildIndex());
		return c.text(index, 200, { 'content-type': 'text/markdown; charset=utf-8' });
	});

	// Log
	wiki.get('/log.md', async (c) => {
		const vault = resolveVault(c.env);
		const log = (await vault.getNote('log.md')) ?? '# Activity Log\n';
		return c.text(log, 200, { 'content-type': 'text/markdown; charset=utf-8' });
	});

	// Story note
	wiki.get('/stories/:id', async (c) => {
		const id = c.req.param('id').replace(/\.md$/, '');
		const vault = resolveVault(c.env);
		const note = await vault.getNote(`stories/${id}.md`);
		if (!note) return c.json({ error: 'not_found', path: `stories/${id}.md` }, 404);
		return c.text(note, 200, { 'content-type': 'text/markdown; charset=utf-8' });
	});

	// Concept note
	wiki.get('/concepts/:slug', async (c) => {
		const slug = c.req.param('slug').replace(/\.md$/, '');
		const vault = resolveVault(c.env);
		const note = await vault.getNote(`concepts/${slug}.md`);
		if (!note) return c.json({ error: 'not_found', path: `concepts/${slug}.md` }, 404);
		return c.text(note, 200, { 'content-type': 'text/markdown; charset=utf-8' });
	});

	// Manifest for Obsidian sync plugins
	wiki.get('/manifest', async (c) => {
		const vault = resolveVault(c.env);
		const manifest = await vault.getManifest();
		return c.json(manifest);
	});

	// 1-Click Vault Download for Obsidian
	wiki.get('/vault.zip', async (c) => {
		const vault = resolveVault(c.env);
		const zipBytes = await vault.exportVaultZip();
		return new Response(zipBytes as unknown as BodyInit, {
			status: 200,
			headers: {
				'content-type': 'application/zip',
				'content-disposition': 'attachment; filename="library-obsidian-vault.zip"',
				'content-length': String(zipBytes.byteLength),
			},
		});
	});

	// Curation endpoint
	wiki.post('/curate', async (c) => {
		const story = (await c.req.json()) as OKFStoryNote;
		if (!story.id || !story.title || !story.resource) {
			return c.json({ error: 'invalid_story', details: 'Missing id, title, or resource' }, 400);
		}
		const vault = resolveVault(c.env);
		const path = await vault.saveStoryNote(story);
		return c.json({ status: 'curated', path, id: story.id });
	});

	return wiki;
}
