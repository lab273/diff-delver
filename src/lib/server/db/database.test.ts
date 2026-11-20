import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
	type DatabaseError
} from './index.ts';
import { insertReport, reportById } from './tables/reports.ts';
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
		expect(rows.map((r) => r.applied_at)).toEqual([1_700_000_000_000]);
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
		expect(error.kind).toBe('DatabaseUnusable');
		expect(describeDatabaseError(error)).toMatch(/could not open its database/);
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
		expect(describeDatabaseError(error)).toMatch(/table reports.*column store_id/);
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
