/**
 * Pi `ExecutionEnv` over a Flue `SandboxDriver` (PI_UPGRADE_PLAN.md §2.6).
 *
 * Pi's portable `read`/`write`/`edit`/`bash` tools reach the workspace only
 * through this environment, so every Flue sandbox adapter (just-bash, CF
 * Containers, E2B, Daytona, …) serves them unchanged. Pure POSIX path logic:
 * no `node:` imports, so it runs on workerd.
 *
 * `SandboxDriver` is a narrower contract than Pi's `FileSystem`: it has no
 * rename, append, truncate, or temp-file verbs. Those are composed from the
 * driver's read/write/remove, which is not atomic — acceptable for the tools
 * Pi ships (they use none of them on their success paths) and documented for
 * anything else.
 */
import type { Context } from '@earendil-works/chord';
import {
	ExecutionError,
	type ExecutionEnv,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
} from '@earendil-works/pi-durable/env';
import { writeFileCreatingParents, type SandboxDriver } from '../sandbox.ts';

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Normalize a POSIX path: collapse `.`/`..`/duplicate slashes; keep it absolute. */
export function normalizePosixPath(path: string): string {
	const absolute = path.startsWith('/');
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
			else if (!absolute) parts.push('..');
			continue;
		}
		parts.push(part);
	}
	const joined = parts.join('/');
	return absolute ? `/${joined}` : joined || '.';
}

function resolveAgainst(cwd: string, path: string): string {
	return normalizePosixPath(path.startsWith('/') ? path : `${cwd}/${path}`);
}

function basename(path: string): string {
	const normalized = normalizePosixPath(path);
	const slash = normalized.lastIndexOf('/');
	return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function parentDir(path: string): string {
	const normalized = normalizePosixPath(path);
	const slash = normalized.lastIndexOf('/');
	return slash <= 0 ? '/' : normalized.slice(0, slash);
}

/** Map a driver failure onto Pi's file error vocabulary by its message. */
function fileErrorFrom(error: unknown, path: string, context: Context): FileError {
	if (context.abortSignal?.aborted) return new FileError('aborted', 'Operation aborted', path);
	const cause = error instanceof Error ? error : new Error(String(error));
	const text = `${(error as { code?: unknown })?.code ?? ''} ${cause.message}`;
	let code: FileErrorCode = 'unknown';
	if (/ENOENT|not found|no such file/i.test(text)) code = 'not_found';
	else if (/EACCES|EPERM|permission denied/i.test(text)) code = 'permission_denied';
	else if (/ENOTDIR|not a directory/i.test(text)) code = 'not_directory';
	else if (/EISDIR|is a directory/i.test(text)) code = 'is_directory';
	return new FileError(code, cause.message, path, cause);
}

async function attempt<T>(
	path: string,
	context: Context,
	run: () => Promise<T>,
): Promise<Result<T, FileError>> {
	if (context.abortSignal?.aborted) return fail(new FileError('aborted', 'Operation aborted', path));
	try {
		return ok(await run());
	} catch (error) {
		return fail(fileErrorFrom(error, path, context));
	}
}

function splitLines(text: string): { text: string; terminated: boolean }[] {
	if (text.length === 0) return [];
	const lines = text.split('\n');
	const terminated = text.endsWith('\n');
	if (terminated) lines.pop();
	return lines.map((line, index) => ({
		text: line.endsWith('\r') ? line.slice(0, -1) : line,
		terminated: index < lines.length - 1 || terminated,
	}));
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const joined = new Uint8Array(left.byteLength + right.byteLength);
	joined.set(left, 0);
	joined.set(right, left.byteLength);
	return joined;
}

const encoder = new TextEncoder();
const toBytes = (content: string | Uint8Array): Uint8Array =>
	typeof content === 'string' ? encoder.encode(content) : content;

/**
 * Wrap a Flue sandbox driver as a Pi execution environment rooted at `cwd`.
 * Relative paths resolve against `cwd`; the driver receives absolute paths.
 */
export function executionEnvFromSandbox(driver: SandboxDriver, cwd: string): ExecutionEnv {
	const root = normalizePosixPath(cwd.startsWith('/') ? cwd : `/${cwd}`);
	const abs = (path: string) => resolveAgainst(root, path);
	let tempCounter = 0;
	const tempName = (prefix: string, suffix = '') =>
		`/tmp/${prefix}${Date.now().toString(36)}-${(tempCounter++).toString(36)}-${crypto.randomUUID().slice(0, 8)}${suffix}`;

	const fileInfo = async (path: string, context: Context): Promise<Result<FileInfo, FileError>> => {
		const resolved = abs(path);
		return attempt(resolved, context, async () => {
			const stat = await driver.stat(resolved);
			return {
				name: basename(resolved),
				path: resolved,
				kind: stat.isSymbolicLink ? 'symlink' : stat.isDirectory ? 'directory' : 'file',
				size: stat.size ?? 0,
				mtimeMs: stat.mtime?.getTime() ?? 0,
			};
		});
	};

	const readTextFile = (path: string, context: Context) => {
		const resolved = abs(path);
		return attempt(resolved, context, () => driver.readFile(resolved));
	};

	const writeFile = (path: string, content: string | Uint8Array, context: Context) => {
		const resolved = abs(path);
		return attempt(resolved, context, () =>
			writeFileCreatingParents(
				() => driver.writeFile(resolved, content),
				() => driver.mkdir(parentDir(resolved), { recursive: true }),
			),
		);
	};

	const env: ExecutionEnv = {
		cwd: root,
		async absolutePath(path, _context) {
			return ok(abs(path));
		},
		async joinPath(parts, _context) {
			return ok(normalizePosixPath(parts.join('/')));
		},
		readTextFile,
		async openTextLineReader(path, context) {
			const text = await readTextFile(path, context);
			if (!text.ok) return text;
			const lines = splitLines(text.value);
			let next = 0;
			const reader: TextLineReader = {
				async readLine(_lineContext) {
					return ok(lines[next++]);
				},
				async close(_closeContext) {},
			};
			return ok(reader);
		},
		async readTextLines(path, options, context) {
			const text = await readTextFile(path, context);
			if (!text.ok) return text;
			const lines = splitLines(text.value).map((line) => line.text);
			return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
		},
		readBinaryFile(path, context) {
			const resolved = abs(path);
			return attempt(resolved, context, () => driver.readFileBuffer(resolved));
		},
		writeFile,
		async appendFile(path, content, context) {
			const resolved = abs(path);
			return attempt(resolved, context, async () => {
				const existing = (await driver.exists(resolved))
					? await driver.readFileBuffer(resolved)
					: new Uint8Array();
				await driver.writeFile(resolved, concatBytes(existing, toBytes(content)));
			});
		},
		async truncateFile(path, size, context) {
			const resolved = abs(path);
			return attempt(resolved, context, async () => {
				const existing = await driver.readFileBuffer(resolved);
				const next = new Uint8Array(size);
				next.set(existing.subarray(0, Math.min(size, existing.byteLength)));
				await driver.writeFile(resolved, next);
			});
		},
		async flushFile(path, context) {
			// Drivers persist on write; there is no open handle to flush.
			const resolved = abs(path);
			return attempt(resolved, context, async () => {});
		},
		async renameFile(sourcePath, destinationPath, context) {
			const source = abs(sourcePath);
			const destination = abs(destinationPath);
			return attempt(source, context, async () => {
				const bytes = await driver.readFileBuffer(source);
				await writeFileCreatingParents(
					() => driver.writeFile(destination, bytes),
					() => driver.mkdir(parentDir(destination), { recursive: true }),
				);
				await driver.rm(source, { force: true });
			});
		},
		fileInfo,
		async listDir(path, context) {
			const resolved = abs(path);
			const names = await attempt(resolved, context, () => driver.readdir(resolved));
			if (!names.ok) return names;
			const infos: FileInfo[] = [];
			for (const name of names.value) {
				const info = await fileInfo(`${resolved}/${name}`, context);
				if (!info.ok) return info;
				infos.push(info.value);
			}
			return ok(infos);
		},
		async canonicalPath(path, context) {
			// Drivers expose no realpath; the normalized absolute path is canonical for them.
			const resolved = abs(path);
			const exists = await attempt(resolved, context, () => driver.exists(resolved));
			if (!exists.ok) return exists;
			return exists.value
				? ok(resolved)
				: fail(new FileError('not_found', `No such file or directory: ${resolved}`, resolved));
		},
		exists(path, context) {
			const resolved = abs(path);
			return attempt(resolved, context, () => driver.exists(resolved));
		},
		createDir(path, options, context) {
			const resolved = abs(path);
			return attempt(resolved, context, () =>
				driver.mkdir(resolved, { recursive: options?.recursive === true }),
			);
		},
		remove(path, options, context) {
			const resolved = abs(path);
			return attempt(resolved, context, () =>
				driver.rm(resolved, {
					...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
					...(options?.force !== undefined ? { force: options.force } : {}),
				}),
			);
		},
		async createTempDir(prefix, context) {
			const path = tempName(prefix ?? 'pi-');
			const created = await attempt(path, context, () => driver.mkdir(path, { recursive: true }));
			return created.ok ? ok(path) : created;
		},
		async createTempFile(options, context) {
			const path = tempName(options?.prefix ?? 'pi-', options?.suffix ?? '');
			const written = await writeFile(path, '', context);
			return written.ok ? ok(path) : written;
		},
		async cleanup(_context) {},
		async exec(
			command: string,
			options: ShellExecOptions | undefined,
			context: Context,
		): Promise<Result<ShellExecResult, ExecutionError>> {
			const signal = context.abortSignal;
			if (signal?.aborted) return fail(new ExecutionError('aborted', 'Command aborted'));
			if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
				return fail(
					new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'),
				);
			}
			const timeoutMs = options?.timeout === undefined ? undefined : options.timeout * 1000;
			// `inheritEnv: false` cannot be honoured by drivers, which always run
			// in the sandbox's own environment; supplied variables are layered on.
			let result: { stdout: string; stderr: string; exitCode: number };
			try {
				result = await driver.exec(command, {
					cwd: options?.cwd === undefined ? root : abs(options.cwd),
					...(options?.env !== undefined ? { env: options.env } : {}),
					...(timeoutMs !== undefined ? { timeoutMs } : {}),
					...(signal !== undefined ? { signal } : {}),
				});
			} catch (error) {
				if (signal?.aborted) return fail(new ExecutionError('aborted', 'Command aborted'));
				const cause = error instanceof Error ? error : new Error(String(error));
				const code = /timed? ?out/i.test(cause.message) ? 'timeout' : 'unknown';
				return fail(new ExecutionError(code, cause.message, cause));
			}
			const output = result.stderr ? `${result.stdout}${result.stderr}` : result.stdout;
			if (output.length > 0) options?.onOutput?.(output, context);
			let spillPath: string | undefined;
			const spill = options?.spill;
			if (
				spill !== undefined &&
				(encoder.encode(output).byteLength > spill.afterBytes ||
					output.split('\n').length > spill.afterLines)
			) {
				const path = tempName('pi-bash-', '.log');
				const written = await writeFile(path, output, context);
				if (written.ok) spillPath = path;
			}
			return ok({ exitCode: result.exitCode, ...(spillPath !== undefined ? { spillPath } : {}) });
		},
	};
	return env;
}
