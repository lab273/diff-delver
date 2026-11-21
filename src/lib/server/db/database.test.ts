import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock } from '#lib/core/clock.ts';
import type { Report } from '#lib/core/reports/report.ts';
import { sequentialIds } from '#lib/core/ids.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { listDirectory } from '../../../../tests/support/directory-listing.ts';
import { tempDirectory } from '../../../../tests/support/fixture-repos.ts';
import { absolutePath } from '../../../../tests/support/git-repo.ts';
import { value } from '../../../../tests/support/git-source-helpers.ts';
import { aReport, aRevision, at } from '../../../../tests/support/report-rows.ts';
import {
	APPLICATION_ID,
	Database,
	DATABASE_FILE,
	describeDatabaseError,
	LATEST_VERSION,
	MIGRATIONS,
	type DatabaseError,
	type Migration,
	type TableName
} from './index.ts';
import { sqliteError } from './database.ts';
import { schemaVersionOf } from '#lib/core/schema-version.tiny.ts';
import { insertReport, reportById, setReportState } from './tables/reports.ts';
import { insertRevision } from './tables/revisions.ts';

const clock = () => settableClock(at(1_700_000_000_000));

async function opened(dir?: AbsolutePath): Promise<Database> {
	return value(await Database.open(dir ?? (await tempDirectory()), clock()));
}

/** Writes a report, failing the test if it cannot. */
function store(db: Database, report: Report): Result<void, DatabaseError> {
	return db.write((q) => {
		insertReport(q, report);
		return ok(undefined);
	});
}

function failure(result: Result<unknown, DatabaseError>): DatabaseError {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

/** The first schema version alone, to make a file as the first release of diff delver did. */
const FIRST: readonly Migration[] = MIGRATIONS.slice(0, 1);

/** A schema version after the newest, for the upgrade tests: a new table and a new column. */
const NEXT: Migration = {
	version: schemaVersionOf(LATEST_VERSION + 1),
	name: 'notes, and pinned reports',
	sql: `
CREATE TABLE notes (
	report_id TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
	body TEXT NOT NULL
) STRICT;
ALTER TABLE reports ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
`
};

/** Everything in the file a migration could change: the schema, the version and every row. */
function schemaAndRows(dir: AbsolutePath): unknown {
	const raw = new DatabaseSync(join(dir, DATABASE_FILE), { readOnly: true });
	try {
		const schema = raw
			.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name')
			.all()
			.map((r) => ({ ...r }));
		const rows = Object.fromEntries(
			schema
				.filter((t) => t.type === 'table')
				.map((t) => [
					String(t.name),
					raw
						.prepare(`SELECT * FROM "${String(t.name)}"`)
						.all()
						.map((r) => ({ ...r }))
				])
		);
		const version = { ...raw.prepare('PRAGMA user_version').get() };
		return { schema, rows, version };
	} finally {
		raw.close();
	}
}

/** Every row of every table but the record of migrations. */
function rowsOf(dir: AbsolutePath): Record<string, unknown> {
	const raw = new DatabaseSync(join(dir, DATABASE_FILE), { readOnly: true });
	try {
		const tables = raw
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name != 'schema_migrations' ORDER BY name"
			)
			.all()
			.map((t) => String(t.name));
		return Object.fromEntries(
			tables.map((name) => [
				name,
				raw
					.prepare(`SELECT * FROM "${name}"`)
					.all()
					.map((r) => ({ ...r }))
			])
		);
	} finally {
		raw.close();
	}
}

describe('the database', () => {
	it('is made in the data directory, with every migration recorded and its settings on', async () => {
		const data = absolutePath(join(await tempDirectory(), 'not', 'made', 'yet'));
		const db = value(await Database.open(data, clock()));
		expect(db.file).toBe(join(data, DATABASE_FILE));
		const read = db.read((q) =>
			ok({
				migrations: q.all('SELECT version, name, applied_at FROM schema_migrations'),
				foreignKeys: q.get('PRAGMA foreign_keys'),
				journal: q.get('PRAGMA journal_mode'),
				busy: q.get('PRAGMA busy_timeout'),
				app: q.get('PRAGMA application_id'),
				version: q.get('PRAGMA user_version')
			})
		);
		db.close();
		const v = value(read);
		expect(v.migrations.map((m) => ({ ...m }))).toEqual([
			{
				version: 1,
				name: 'reports, revisions, sections, assignments and reviewed marks',
				applied_at: 1_700_000_000_000
			},
			{
				version: 2,
				name: 'reports can be closed because their snapshot is gone',
				applied_at: 1_700_000_000_000
			},
			{
				version: 3,
				name: 'what each update of a diff changed, and which changes are new since the version before',
				applied_at: 1_700_000_000_000
			},
			{
				version: 4,
				name: 'revisions to check for changes to a file beside its lines',
				applied_at: 1_700_000_000_000
			},
			{
				version: 5,
				name: 'which changes an update unmarked because lines close to them changed',
				applied_at: 1_700_000_000_000
			},
			{
				version: 6,
				name: 'how the person likes diffs shown',
				applied_at: 1_700_000_000_000
			},
			{
				version: 7,
				name: "the agent's overview of each version, and each section's cross-references",
				applied_at: 1_700_000_000_000
			}
		]);
		expect({ ...v.foreignKeys }).toEqual({ foreign_keys: 1 });
		expect({ ...v.journal }).toEqual({ journal_mode: 'wal' });
		expect({ ...v.busy }).toEqual({ timeout: 5000 });
		expect({ ...v.app }).toEqual({ application_id: APPLICATION_ID });
		expect({ ...v.version }).toEqual({ user_version: LATEST_VERSION });
	});

	it('opens again without applying anything twice', async () => {
		const dir = await tempDirectory();
		(await opened(dir)).close();
		const later = settableClock(at(1_800_000_000_000));
		const db = value(await Database.open(dir, later));
		const rows = value(db.read((q) => ok(q.all('SELECT applied_at FROM schema_migrations'))));
		db.close();
		expect(rows.map((r) => r.applied_at)).toEqual(MIGRATIONS.map(() => 1_700_000_000_000));
	});

	it('refuses a database a newer diff delver has changed, and says to update', async () => {
		const dir = await tempDirectory();
		(await opened(dir)).close();
		const raw = new DatabaseSync(join(dir, DATABASE_FILE));
		raw.exec("INSERT INTO schema_migrations VALUES (99, 'from the future', 0)");
		raw.close();
		const error = failure(await Database.open(dir, clock()));
		expect(error).toEqual({
			kind: 'DatabaseTooNew',
			file: join(dir, DATABASE_FILE),
			version: 99,
			known: LATEST_VERSION
		});
		expect(describeDatabaseError(error)).toMatch(
			/newer version of diff delver.*Update diff delver/
		);
	});

	it('upgrades a version 1 file to the current schema, keeping every row and its foreign keys', async () => {
		const dir = await tempDirectory();
		const ids = sequentialIds();
		const id = ids.reportId();
		const one = value(await Database.open(dir, clock(), FIRST));
		value(
			one.write((q) => {
				insertReport(q, aReport(id));
				insertRevision(q, aRevision(ids.revisionId(), id));
				setReportState(q, id, { kind: 'closed', reason: 'source-empty' }, at(3_000));
				return ok(undefined);
			})
		);
		one.close();
		const before = rowsOf(dir);

		const db = await opened(dir);
		// Every row kept; the later migrations' tables are there, empty, except that the revision is to be checked.
		expect(rowsOf(dir)).toEqual({
			...before,
			new_units: [],
			unmarked_units: [],
			settings: [],
			overviews: [],
			section_references: [],
			revision_updates: [],
			revisions_to_check: [{ revision_id: 'v_1' }]
		});
		const checked = value(
			db.write((q) => {
				const problems = q.all('PRAGMA foreign_key_check');
				setReportState(q, id, { kind: 'closed', reason: 'snapshot-gone' }, at(4_000));
				const reason = q.get('SELECT closed_reason FROM reports')?.closed_reason;
				q.run('DELETE FROM reports');
				return ok({ problems, reason, revisions: q.all('SELECT id FROM revisions') });
			})
		);
		db.close();
		expect(checked).toEqual({ problems: [], reason: 'snapshot-gone', revisions: [] });
	});

	it('upgrades a version 1 file through every migration and a next one that adds a table and a column', async () => {
		const dir = await tempDirectory();
		const id = sequentialIds().reportId();
		const one = value(await Database.open(dir, clock(), FIRST));
		value(store(one, aReport(id)));
		one.close();

		const later = settableClock(at(1_800_000_000_000));
		const db = value(await Database.open(dir, later, [...MIGRATIONS, NEXT]));
		const read = value(
			db.read((q) =>
				ok({
					migrations: q.all('SELECT version, applied_at FROM schema_migrations ORDER BY version'),
					version: q.get('PRAGMA user_version'),
					notes: q.all('SELECT * FROM notes'),
					pinned: q.all('SELECT id, pinned FROM reports')
				})
			)
		);
		const report = value(db.read((q) => reportById(q, id)));
		db.close();
		expect(read.migrations.map((m) => ({ ...m }))).toEqual([
			{ version: 1, applied_at: 1_700_000_000_000 },
			...[...MIGRATIONS.slice(1), NEXT].map((m) => ({
				version: m.version,
				applied_at: 1_800_000_000_000
			}))
		]);
		expect({ ...read.version }).toEqual({ user_version: NEXT.version });
		expect(read.notes).toEqual([]);
		expect(read.pinned.map((r) => ({ ...r }))).toEqual([{ id, pinned: 0 }]);
		expect(report?.id).toBe(id);
	});

	it('leaves a file exactly at its version when the next migration fails halfway', async () => {
		const dir = await tempDirectory();
		const one = await opened(dir);
		value(store(one, aReport(sequentialIds().reportId())));
		one.close();
		const before = schemaAndRows(dir);

		const broken: Migration = {
			version: NEXT.version,
			name: 'fails after its first statements',
			sql: `${NEXT.sql}\nINSERT INTO no_such_table VALUES (1);`
		};
		const error = failure(await Database.open(dir, clock(), [...MIGRATIONS, broken]));
		expect(error).toMatchObject({
			kind: 'MigrationFailed',
			file: join(dir, DATABASE_FILE),
			version: NEXT.version
		});
		expect(describeDatabaseError(error)).toMatch(/is as it was/);
		expect(schemaAndRows(dir)).toEqual(before);
		// And it still opens with the migrations it has.
		(await opened(dir)).close();
	});

	it('refuses a file a list of migrations does not reach, once a newer list has upgraded it', async () => {
		const dir = await tempDirectory();
		value(await Database.open(dir, clock(), [...MIGRATIONS, NEXT])).close();
		const error = failure(await Database.open(dir, clock()));
		expect(error).toEqual({
			kind: 'DatabaseTooNew',
			file: join(dir, DATABASE_FILE),
			version: NEXT.version,
			known: LATEST_VERSION
		});
	});

	it('refuses a file that is not a database, and leaves it as it was', async () => {
		const dir = await tempDirectory();
		await writeFile(join(dir, DATABASE_FILE), 'These are my notes, not a database.\n'.repeat(50));
		const before = await listDirectory(dir);
		const error = failure(await Database.open(dir, clock()));
		expect(error.kind).toBe('NotADatabase');
		expect(describeDatabaseError(error)).toMatch(
			/is not diff delver's database.*Move it out of the way/
		);
		expect(await listDirectory(dir)).toEqual(before);
	});

	it("refuses another program's SQLite database", async () => {
		const dir = await tempDirectory();
		const raw = new DatabaseSync(join(dir, DATABASE_FILE));
		raw.exec('CREATE TABLE contacts (name TEXT)');
		raw.close();
		expect(failure(await Database.open(dir, clock())).kind).toBe('NotADatabase');
	});

	it('says plainly when the file is damaged', async () => {
		const dir = await tempDirectory();
		(await opened(dir)).close();
		const file = join(dir, DATABASE_FILE);
		const bytes = await readFile(file);
		bytes[100] = 0x99; // the type of the schema's first page
		await writeFile(file, bytes);
		const error = failure(await Database.open(dir, clock()));
		expect(error.kind).toBe('DatabaseCorrupt');
		expect(describeDatabaseError(error)).toMatch(/is damaged.*Restore it from a backup/);
	});

	it('says plainly when the data directory cannot hold it', async () => {
		const dir = await tempDirectory();
		await writeFile(join(dir, 'file'), '');
		const error = failure(await Database.open(absolutePath(join(dir, 'file', 'data')), clock()));
		expect(error).toMatchObject({ kind: 'DatabaseUnusable', problem: 'cannot-open' });
		expect(describeDatabaseError(error)).toMatch(/could not open its database/);
	});

	it.each(['the file', 'its folder'])(
		'says where the database is and what to do when %s is read-only',
		async (which) => {
			const dir = await tempDirectory();
			(await opened(dir)).close();
			const file = join(dir, DATABASE_FILE);
			const target = which === 'the file' ? file : dir;
			await chmod(target, which === 'the file' ? 0o444 : 0o555);
			try {
				const error = failure(await Database.open(dir, clock()));
				expect(error).toMatchObject({ kind: 'DatabaseUnusable', file, problem: 'read-only' });
				const message = describeDatabaseError(error);
				expect(message).toContain(file);
				expect(message).toMatch(/cannot write to it.*read-only.*writable/);
				expect(message).not.toMatch(/Try again/);
			} finally {
				await chmod(target, which === 'the file' ? 0o644 : 0o755);
			}
		}
	);

	it('says what to do with a damaged row in words that fit its table', () => {
		const advice = (table: TableName): string =>
			describeDatabaseError({ kind: 'StoredRowInvalid', table, detail: 'column x: bad' });
		const ofReports: TableName[] = [
			'reports',
			'revisions',
			'sections',
			'assignments',
			'reviewed_marks'
		];
		for (const table of ofReports) {
			expect(advice(table)).toMatch(/Delete that diff from the list of diffs/);
			// In the reviewer's words, not the database's.
			expect(advice(table)).not.toMatch(/table|column|_/);
		}
		const ofNone: TableName[] = ['schema_migrations', 'unreferenced_snapshots'];
		for (const table of ofNone) {
			expect(advice(table)).not.toMatch(/Delete/);
			expect(advice(table)).toMatch(
				/Restore the database from a backup, or move it out of the way/
			);
		}
	});

	it('says plainly that the disk is full, rather than to try again', () => {
		const file = absolutePath('/data/diff-delver.sqlite');
		const full = Object.assign(new Error('database or disk is full'), {
			errcode: 13,
			errstr: 'database or disk is full'
		});
		const error = sqliteError(file, full);
		expect(error).toMatchObject({ kind: 'DatabaseUnusable', problem: 'disk-full' });
		expect(describeDatabaseError(error)).toMatch(/disk that holds it is full.*Free some space/);
	});

	it('reads a row that does not hold what its table should as an error naming the table', async () => {
		const db = await opened();
		const ids = sequentialIds();
		const id = ids.reportId();
		value(
			db.write((q) => {
				insertReport(q, aReport(id));
				q.run("UPDATE reports SET store_id = 'Not A Store' WHERE id = ?", id);
				return ok(undefined);
			})
		);
		const read = db.read((q) => reportById(q, id));
		db.close();
		const error = failure(read);
		expect(error).toMatchObject({ kind: 'StoredRowInvalid', table: 'reports' });
		if (error.kind === 'StoredRowInvalid') expect(error.detail).toMatch(/store_id/);
		expect(describeDatabaseError(error)).toMatch(/\(a diff’s details\) could not be read/);
		expect(describeDatabaseError(error)).not.toMatch(/reports|store_id/);
	});

	it('leaves everything as it was when a write fails or throws', async () => {
		const db = await opened();
		const ids = sequentialIds();
		const first = ids.reportId();
		const refusal: { readonly kind: 'Refused' } = { kind: 'Refused' };
		const refused = db.write((q) => {
			insertReport(q, aReport(first));
			return err(refusal);
		});
		expect(refused).toEqual({ ok: false, error: { kind: 'Refused' } });
		const second = ids.reportId();
		const thrown = db.write((q): Result<void, DatabaseError> => {
			insertReport(q, aReport(second, absolutePath('/other')));
			// A revision of a report that does not exist breaks a foreign key.
			insertRevision(q, aRevision(ids.revisionId(), ids.reportId()));
			return ok(undefined);
		});
		expect(failure(thrown).kind).toBe('DatabaseFailed');
		const left = value(db.read((q) => ok(q.all('SELECT id FROM reports'))));
		db.close();
		expect(left).toEqual([]);
	});

	it('refuses a second open report for one source', async () => {
		const db = await opened();
		const ids = sequentialIds();
		value(store(db, aReport(ids.reportId())));
		const again = store(db, aReport(ids.reportId()));
		db.close();
		expect(failure(again).kind).toBe('DatabaseFailed');
	});

	it('keeps working beside a second connection to the same file', async () => {
		const dir = await tempDirectory();
		await mkdir(dir, { recursive: true });
		const one = await opened(dir);
		const two = await opened(dir);
		const ids = sequentialIds();
		const id = ids.reportId();
		value(store(one, aReport(id)));
		const seen = value(two.read((q) => reportById(q, id)));
		one.close();
		two.close();
		expect(seen?.id).toBe(id);
	});
});
