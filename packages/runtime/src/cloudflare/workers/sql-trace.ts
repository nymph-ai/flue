/**
 * Every row a Durable Object's storage reads and writes, by statement, as
 * workerd reports it: what Cloudflare bills. `installSqlTrace()` wraps
 * `SqlStorage.prototype.exec` — so the Agents SDK's own statements, Flue's
 * stores that bypass `doSqliteDatabase` and Pi's `SqliteStorage` are all
 * seen — and counts the key-value API's keys (`get`/`put`/`delete`), which
 * SQLite-backed objects keep in a table of their own and which no cursor
 * reports — both the asynchronous API and the synchronous `storage.kv` — and
 * the alarm writes (`setAlarm`, billed as a row written; `deleteAlarm`). A cursor's
 * `rowsRead`/`rowsWritten` are read when the trace is summarized, after its
 * consumer has stepped it.
 *
 * Imported only by `*.workers.test.ts`.
 */

export interface StatementCost {
	calls: number;
	rowsRead: number;
	rowsWritten: number;
}

/** Whose statement: by the tables it names. */
export type StatementOwner = 'agents-sdk' | 'flue' | 'pi';

export function statementOwner(sql: string): StatementOwner {
	if (/\bcf_agents?_/.test(sql)) return 'agents-sdk';
	if (/\bflue_/.test(sql)) return 'flue';
	return 'pi';
}

export interface TraceSummary {
	readonly rowsRead: number;
	readonly rowsWritten: number;
	readonly byOwner: Readonly<Record<StatementOwner, { rowsRead: number; rowsWritten: number }>>;
	/** Keys the key-value API read and wrote (`get`/`put`/`delete`, async and `storage.kv`). */
	readonly kv: { readonly read: number; readonly written: number };
	/** `setAlarm` calls: each is billed as a row written. */
	readonly alarms: number;
	/** `deleteAlarm` calls (not billed as rows). */
	readonly alarmDeletes: number;
	/** Per statement text (whitespace collapsed), most expensive first. */
	readonly statements: ReadonlyArray<readonly [string, StatementCost]>;
}

interface Cursor {
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

class SqlTrace {
	#cursors: { sql: string; cursor: Cursor }[] = [];
	#kv = { read: 0, written: 0 };
	#alarms = 0;
	#alarmDeletes = 0;
	recording = true;

	record(sql: string, cursor: Cursor): void {
		if (this.recording) this.#cursors.push({ sql, cursor });
	}

	kv(kind: 'read' | 'written', keys: number): void {
		if (this.recording) this.#kv[kind] += keys;
	}

	alarm(kind: 'set' | 'delete'): void {
		if (!this.recording) return;
		if (kind === 'set') this.#alarms++;
		else this.#alarmDeletes++;
	}

	reset(): void {
		this.#cursors = [];
		this.#kv = { read: 0, written: 0 };
		this.#alarms = 0;
		this.#alarmDeletes = 0;
	}

	/**
	 * Run `callback` without recording what it reads (the test's own polling).
	 * Synchronous, so no statement of the object's own work interleaves.
	 */
	unrecorded<T>(callback: () => T): T {
		const was = this.recording;
		this.recording = false;
		try {
			return callback();
		} finally {
			this.recording = was;
		}
	}

	summary(): TraceSummary {
		const statements = new Map<string, StatementCost>();
		let rowsRead = 0;
		let rowsWritten = 0;
		const byOwner: Record<StatementOwner, { rowsRead: number; rowsWritten: number }> = {
			'agents-sdk': { rowsRead: 0, rowsWritten: 0 },
			flue: { rowsRead: 0, rowsWritten: 0 },
			pi: { rowsRead: 0, rowsWritten: 0 },
		};
		for (const { sql, cursor } of this.#cursors) {
			const key = sql.replace(/\s+/g, ' ').trim();
			const cost = statements.get(key) ?? { calls: 0, rowsRead: 0, rowsWritten: 0 };
			cost.calls++;
			cost.rowsRead += cursor.rowsRead;
			cost.rowsWritten += cursor.rowsWritten;
			statements.set(key, cost);
			rowsRead += cursor.rowsRead;
			rowsWritten += cursor.rowsWritten;
			const owner = byOwner[statementOwner(key)];
			owner.rowsRead += cursor.rowsRead;
			owner.rowsWritten += cursor.rowsWritten;
		}
		return {
			rowsRead,
			rowsWritten,
			byOwner,
			kv: { ...this.#kv },
			alarms: this.#alarms,
			alarmDeletes: this.#alarmDeletes,
			statements: [...statements.entries()].sort(
				([, a], [, b]) => b.rowsRead + b.rowsWritten - (a.rowsRead + a.rowsWritten),
			),
		};
	}
}

/** The one trace of this isolate; a test runs one traced object at a time. */
export const sqlTrace = new SqlTrace();

let installed = false;

const keyCount = (keys: unknown): number =>
	Array.isArray(keys)
		? keys.length
		: keys !== null && typeof keys === 'object'
			? Object.keys(keys).length
			: 1;

/** Wrap this isolate's `SqlStorage` and `DurableObjectStorage` prototypes, once. */
export function installSqlTrace(storage: DurableObjectStorage): void {
	if (installed) return;
	installed = true;
	const sqlPrototype = Object.getPrototypeOf(storage.sql) as {
		exec: (query: string, ...bindings: unknown[]) => Cursor;
	};
	const exec = sqlPrototype.exec;
	sqlPrototype.exec = function (this: unknown, query: string, ...bindings: unknown[]) {
		const cursor = exec.call(this, query, ...bindings);
		sqlTrace.record(query, cursor);
		return cursor;
	};
	const storagePrototype = Object.getPrototypeOf(storage) as Record<
		'get' | 'put' | 'delete',
		(...args: unknown[]) => unknown
	>;
	const wrap = (method: 'get' | 'put' | 'delete', kind: 'read' | 'written') => {
		const original = storagePrototype[method];
		storagePrototype[method] = function (this: unknown, ...args: unknown[]) {
			sqlTrace.kv(kind, keyCount(args[0]));
			return original.apply(this, args);
		};
	};
	wrap('get', 'read');
	wrap('put', 'written');
	wrap('delete', 'written');
	const kv = (storage as { kv?: object }).kv;
	if (kv) {
		const kvPrototype = Object.getPrototypeOf(kv) as Record<
			'get' | 'put' | 'delete',
			(...args: unknown[]) => unknown
		>;
		for (const [method, kind] of [
			['get', 'read'],
			['put', 'written'],
			['delete', 'written'],
		] as const) {
			const original = kvPrototype[method];
			if (typeof original !== 'function') continue;
			kvPrototype[method] = function (this: unknown, ...args: unknown[]) {
				sqlTrace.kv(kind, keyCount(args[0]));
				return original.apply(this, args);
			};
		}
	}
	const alarmPrototype = storagePrototype as unknown as Record<
		'setAlarm' | 'deleteAlarm',
		(...args: unknown[]) => unknown
	>;
	for (const method of ['setAlarm', 'deleteAlarm'] as const) {
		const original = alarmPrototype[method];
		alarmPrototype[method] = function (this: unknown, ...args: unknown[]) {
			sqlTrace.alarm(method === 'setAlarm' ? 'set' : 'delete');
			return original.apply(this, args);
		};
	}
}

/** `[first-wake]` report lines: totals, then the `limit` most expensive statements. */
export function formatTrace(label: string, summary: TraceSummary, limit = 200): string {
	const lines = summary.statements
		.slice(0, limit)
		.map(
			([sql, cost]) =>
				`${String(cost.rowsRead).padStart(5)}r ${String(cost.rowsWritten).padStart(4)}w ×${cost.calls} ${sql.slice(0, 140)}`,
		);
	return [
		`[first-wake] ${label}: sql read ${summary.rowsRead} written ${summary.rowsWritten}; kv keys read ${summary.kv.read} written ${summary.kv.written}; setAlarm ${summary.alarms}, deleteAlarm ${summary.alarmDeletes}; ${summary.statements.length} statements`,
		`  by owner: ${Object.entries(summary.byOwner)
			.map(([owner, rows]) => `${owner} ${rows.rowsRead}r/${rows.rowsWritten}w`)
			.join(', ')}`,
		...lines.map((line) => `  ${line}`),
	].join('\n');
}
