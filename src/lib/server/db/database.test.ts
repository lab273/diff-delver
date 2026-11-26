import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { settableClock } from '#lib/core/clock.ts';
import type { Report, Revision } from '#lib/core/reports/report.ts';
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
import { sqliteError, type Queries } from './database.ts';
import { schemaVersionOf } from '#lib/core/schema-version.tiny.ts';
import {
	deleteDraftComment,
	draftCommentOf,
	draftCommentsOf,
	insertDraftComment,
	updateDraftComment
} from './tables/draft-comments.ts';
import { draftSummaryOf, NO_OVERALL_REVIEW, writeDraftSummary } from './tables/draft-summaries.ts';
import { insertReport, reportById, setReportState } from './tables/reports.ts';
import { reviewsOf } from './tables/reviews.ts';
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

/**
 * Adds a revision as a diff delver before migration 13 did, without its test
 * lines and binary files, for a file made with an earlier schema.
 */
function insertEarlierRevision(q: Queries, revision: Revision): void {
	q.run(
		`INSERT INTO revisions (id, report_id, number, store_id, snapshot_id, base_tree, head_tree,
			fingerprint, base_commit, head_commit, left_out, taken_at, file_count, added_lines,
			deleted_lines, counted_units, reviewed_units, ignored_units, uncategorised_units)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		revision.id,
		revision.report,
		revision.number,
		revision.store,
		revision.snapshot,
		revision.baseTree,
		revision.headTree,
		revision.fingerprint,
		revision.baseCommit ?? null,
		revision.headCommit ?? null,
		JSON.stringify(revision.leftOut),
		revision.takenAt,
		revision.size.files,
		revision.size.addedLines,
		revision.size.deletedLines,
		revision.progress.counted,
		revision.progress.reviewed,
		revision.progress.ignored,
		revision.progress.uncategorised
	);
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
			},
			{
				version: 8,
				name: 'how many commits a run of commits is, and the subjects of its oldest and newest',
				applied_at: 1_700_000_000_000
			},
			{
				version: 9,
				name: 'private draft comments on lines of a revision',
				applied_at: 1_700_000_000_000
			},
			{
				version: 10,
				name: 'draft comments whose ids are never used again, with when each was written and changed',
				applied_at: 1_700_000_000_000
			},
			{
				version: 11,
				name: 'finished reviews, with their comments, the text handed over and what was reviewed',
				applied_at: 1_700_000_000_000
			},
			{
				version: 12,
				name: 'the overall review of each draft, and the one each finished review was finished with',
				applied_at: 1_700_000_000_000
			},
			{
				version: 13,
				name: 'how many lines of each version are tests, and its binary files with their sizes',
				applied_at: 1_700_000_000_000
			},
			{
				version: 14,
				name: 'reports of GitHub pull requests, with their titles and descriptions',
				applied_at: 1_700_000_000_000
			},
			{
				version: 15,
				name: 'where each finished review was delivered, and reviews being posted to GitHub',
				applied_at: 1_700_000_000_000
			},
			{
				version: 16,
				name: 'flags on lines, beside comments, in the draft and in finished reviews',
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
				insertEarlierRevision(q, aRevision(ids.revisionId(), id));
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
			// No assignment rows, so no test lines; its binary files are not counted yet.
			revisions: (Array.isArray(before.revisions) ? before.revisions : []).map((row: object) => ({
				...row,
				test_added_lines: 0,
				test_deleted_lines: 0,
				binary_added_files: null,
				binary_added_bytes: null,
				binary_removed_files: null,
				binary_removed_bytes: null,
				binary_changed_files: null,
				binary_changed_before: null,
				binary_changed_after: null
			})),
			new_units: [],
			unmarked_units: [],
			settings: [],
			overviews: [],
			section_references: [],
			commit_runs: [],
			pull_requests: [],
			draft_comments: [],
			draft_summaries: [],
			reviews: [],
			review_comments: [],
			review_marks: [],
			review_deliveries: [],
			github_review_posts: [],
			github_review_post_comments: [],
			github_review_post_marks: [],
			// SQLite's own, for the one table whose ids are never used again.
			sqlite_sequence: [{ name: 'draft_comments', seq: 0 }],
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

	it('counts the test lines of versions saved before they were kept, from their rows, and leaves their binary files for later', async () => {
		const dir = await tempDirectory();
		const ids = sequentialIds();
		const id = ids.reportId();
		const revision = aRevision(ids.revisionId(), id);
		const before = value(await Database.open(dir, clock(), MIGRATIONS.slice(0, 12)));
		value(
			before.write((q) => {
				insertReport(q, aReport(id));
				insertEarlierRevision(q, revision);
				for (const [path, side, first, last, role] of [
					['src/a.test.ts', 'new', 1, 3, 'test'],
					['src/a.test.ts', 'file', 0, 0, 'test'],
					['src/__snapshots__/a.snap', 'old', 2, 2, 'snapshot'],
					['src/a.ts', 'new', 5, 9, 'code'],
					['src/a.ts', 'old', 1, 4, 'code']
				] as const) {
					q.run(
						`INSERT INTO assignments (revision_id, path, side, first_line, last_line, bucket, role)
						VALUES (?, ?, ?, ?, ?, 'uncategorised', ?)`,
						revision.id,
						Buffer.from(path),
						side,
						first,
						last,
						role
					);
				}
				return ok(undefined);
			})
		);
		before.close();
		const db = await opened(dir);
		const read = value(
			db.read((q) =>
				ok({
					revision: q.get(
						'SELECT test_added_lines, test_deleted_lines, binary_added_files, binary_changed_after FROM revisions'
					),
					toCheck: q.all('SELECT revision_id FROM revisions_to_check')
				})
			)
		);
		db.close();
		expect({ ...read.revision }).toEqual({
			test_added_lines: 3,
			test_deleted_lines: 1,
			binary_added_files: null,
			binary_changed_after: null
		});
		// Not a revision to check before the daemon serves: the report service counts its binary files afterwards.
		expect(read.toCheck).toEqual([]);
	});

	it('keeps comments saved before their times were kept, and never uses a deleted one’s id again', async () => {
		const dir = await tempDirectory();
		const ids = sequentialIds();
		const id = ids.reportId();
		const revision = aRevision(ids.revisionId(), id);
		const before = value(await Database.open(dir, clock(), MIGRATIONS.slice(0, 9)));
		value(
			before.write((q) => {
				insertReport(q, aReport(id));
				insertEarlierRevision(q, revision);
				for (const [line, body] of [
					[2, 'Written before the upgrade.'],
					[5, 'And another.']
				] as const) {
					q.run(
						`INSERT INTO draft_comments (revision_id, path, side, first_line, last_line, body)
						 VALUES (?, ?, 'new', ?, ?, ?)`,
						revision.id,
						new TextEncoder().encode('src/a.ts'),
						line,
						line + 1,
						body
					);
				}
				return ok(undefined);
			})
		);
		before.close();

		const db = await opened(dir);
		const comments = value(db.read((q) => draftCommentsOf(q, id)));
		// Each keeps its id and its words, and says it was written when its version was taken.
		expect(comments).toMatchObject([
			{
				id: 1,
				version: revision.number,
				anchor: { path: 'src/a.ts', side: 'new', first: 2, last: 3 },
				body: 'Written before the upgrade.',
				writtenAt: revision.takenAt,
				editedAt: undefined,
				edits: 0
			},
			{ id: 2, anchor: { first: 5, last: 6 }, body: 'And another.', edits: 0 }
		]);

		// The newest deleted, the next comment does not take its id, as it did before the upgrade.
		const [first, second] = comments;
		if (first === undefined || second === undefined) throw new Error('two comments were kept');
		const next = value(
			db.write((q) => {
				deleteDraftComment(q, second.id);
				return insertDraftComment(
					q,
					revision.id,
					'comment',
					first.anchor,
					'After the upgrade.',
					at(9_000)
				);
			})
		);
		expect(next.id).toBe(3);
		// A change counts, and is stamped; the table refuses a count without its time.
		const changed = value(
			db.write((q) => {
				updateDraftComment(q, first.id, 'Changed.', at(9_500));
				return draftCommentOf(q, id, first.id);
			})
		);
		expect(changed).toMatchObject({ body: 'Changed.', editedAt: 9_500, edits: 1 });
		expect(
			failure(
				db.write((q) => {
					q.run('UPDATE draft_comments SET edits = 2 WHERE id = ?', next.id);
					return ok(undefined);
				})
			).kind
		).toBe('DatabaseFailed');
		// Deleting the Delve still takes its comments with it.
		value(
			db.write((q) => {
				q.run('DELETE FROM reports');
				return ok(undefined);
			})
		);
		expect(value(db.read((q) => ok(q.all('SELECT id FROM draft_comments'))))).toEqual([]);
		db.close();
	});

	it('keeps reviews finished before overall reviews were kept, as holding none, and counts each change to one', async () => {
		const dir = await tempDirectory();
		const ids = sequentialIds();
		const id = ids.reportId();
		const revision = aRevision(ids.revisionId(), id);
		const before = value(await Database.open(dir, clock(), MIGRATIONS.slice(0, 11)));
		value(
			before.write((q) => {
				insertReport(q, aReport(id));
				insertEarlierRevision(q, revision);
				q.run(
					`INSERT INTO reviews (report_id, number, revision_id, submitted_at, export_text,
						counted, reviewed, ignored, uncategorised)
					 VALUES (?, 1, ?, 5000, '# Review 1', 3, 1, 0, 0)`,
					id,
					revision.id
				);
				return ok(undefined);
			})
		);
		before.close();

		const db = await opened(dir);
		expect(value(db.read((q) => reviewsOf(q, id)))).toMatchObject([
			{ number: 1, comments: 0, overall: false, text: '# Review 1' }
		]);
		expect(value(db.read((q) => draftSummaryOf(q, id)))).toEqual(NO_OVERALL_REVIEW);
		const changed = value(
			db.write((q) => {
				writeDraftSummary(q, id, 'Looks right.', at(9_000));
				writeDraftSummary(q, id, '', at(9_500));
				return draftSummaryOf(q, id);
			})
		);
		// Emptied, it still counts: a page that read the words before changes nothing.
		expect(changed).toEqual({ body: '', changedAt: 9_500, edits: 2 });
		// Deleting the Delve takes its overall review with it.
		value(
			db.write((q) => {
				q.run('DELETE FROM reports');
				return ok(undefined);
			})
		);
		expect(value(db.read((q) => ok(q.all('SELECT * FROM draft_summaries'))))).toEqual([]);
		db.close();
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
			expect(advice(table)).toMatch(/Delete that Delve from the list of Delves/);
			// In the reviewer's words, not the database's.
			expect(advice(table)).not.toMatch(/table|column|_/);
		}
		expect(advice('draft_comments')).toMatch(
			/Restore the database from a backup to recover the draft comments/
		);
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
		expect(describeDatabaseError(error)).toMatch(/\(a Delve’s details\) could not be read/);
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
