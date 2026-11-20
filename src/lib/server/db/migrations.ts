/**
 * The database schema, as numbered changes applied in order and never edited
 * once released: a later change is a new migration, so a database made by any
 * earlier version can be brought up to date. Each migration runs in its own
 * transaction and is recorded in `schema_migrations` in the same transaction,
 * so a crash leaves it either applied and recorded or not at all.
 *
 * A database whose record holds a migration this version does not know was
 * last used by a newer diff delver; it is refused rather than guessed at.
 */
import type { Clock } from '#lib/core/clock.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import type { Database, Queries } from './database.ts';
import type { DatabaseError } from './database-error.ts';
import { appliedMigrations, recordMigration } from './tables/schema-migrations.ts';

/** SQLite's application id for diff delver's database: "dDlv". Marks the file as ours. */
export const APPLICATION_ID = 0x64446c76;

export interface Migration {
	readonly version: number;
	/** What it changes, in a few words. */
	readonly name: string;
	readonly sql: string;
}

/**
 * Every migration, oldest first. How later tables attach without reshaping these:
 * threads and their messages, reviews and the event log each get a table of their
 * own that refers to `reports.id` (and `revisions.id` for a review, or a thread's
 * anchor) with `ON DELETE CASCADE`; a thread's anchor stores a path as a BLOB with
 * `side` and line columns like `assignments`; a review's copy of the reviewed marks
 * at submission is a table shaped like `reviewed_marks`, keyed by the review.
 */
export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: 'reports, revisions, sections, assignments and reviewed marks',
		sql: `
CREATE TABLE reports (
	id TEXT PRIMARY KEY,
	-- What makes two sources the same (report-identity.ts); one open report per identity.
	identity TEXT NOT NULL,
	source_kind TEXT NOT NULL CHECK (source_kind IN ('git')),
	-- The source in its one written form, such as "working-tree" or "main...feature".
	source TEXT NOT NULL,
	store_id TEXT NOT NULL,
	repository_name TEXT NOT NULL,
	-- Where to find the repository again, to notice that the source changed.
	repository_path TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
	closed_reason TEXT CHECK (closed_reason IN ('reviewer', 'source-empty')),
	created_at INTEGER NOT NULL,
	last_activity_at INTEGER NOT NULL,
	CHECK ((state = 'open') = (closed_reason IS NULL))
) STRICT;
CREATE UNIQUE INDEX reports_one_open_per_source ON reports (identity) WHERE state = 'open';
CREATE INDEX reports_by_activity ON reports (last_activity_at DESC, created_at DESC);

CREATE TABLE revisions (
	id TEXT PRIMARY KEY,
	report_id TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
	number INTEGER NOT NULL CHECK (number >= 1),
	store_id TEXT NOT NULL,
	snapshot_id TEXT NOT NULL,
	base_tree TEXT NOT NULL,
	head_tree TEXT NOT NULL,
	-- The source's fingerprint when the snapshot was taken (DESIGN 3.2).
	fingerprint TEXT NOT NULL,
	base_commit TEXT,
	head_commit TEXT,
	-- What could not be included, as a JSON array of sentences for the reviewer.
	left_out TEXT NOT NULL,
	taken_at INTEGER NOT NULL,
	file_count INTEGER NOT NULL CHECK (file_count >= 0),
	added_lines INTEGER NOT NULL CHECK (added_lines >= 0),
	deleted_lines INTEGER NOT NULL CHECK (deleted_lines >= 0),
	-- Progress for the reports list, kept up to date by every write that changes it.
	counted_units INTEGER NOT NULL CHECK (counted_units >= 0),
	reviewed_units INTEGER NOT NULL CHECK (reviewed_units >= 0),
	ignored_units INTEGER NOT NULL CHECK (ignored_units >= 0),
	uncategorised_units INTEGER NOT NULL CHECK (uncategorised_units >= 0),
	UNIQUE (report_id, number)
) STRICT;
CREATE INDEX revisions_by_snapshot ON revisions (store_id, snapshot_id);

CREATE TABLE sections (
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT,
	position INTEGER NOT NULL CHECK (position >= 0),
	PRIMARY KEY (revision_id, id)
) STRICT, WITHOUT ROWID;

-- Paths are BLOBs of git's exact bytes: a TEXT column would turn bytes that are
-- not UTF-8 into U+FFFD and merge distinct paths. A file-level unit is side
-- 'file' with lines 0 to 0.
CREATE TABLE assignments (
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new', 'file')),
	first_line INTEGER NOT NULL,
	last_line INTEGER NOT NULL,
	bucket TEXT NOT NULL CHECK (bucket IN ('section', 'ignored', 'uncategorised')),
	section_id TEXT,
	-- Who ignored the lines ('rule', 'pattern' or 'agent') and the rule id, the pattern or the agent's reason.
	ignored_by TEXT CHECK (ignored_by IN ('rule', 'pattern', 'agent')),
	ignored_detail TEXT,
	role TEXT NOT NULL CHECK (role IN ('code', 'test', 'snapshot')),
	PRIMARY KEY (revision_id, path, side, first_line),
	FOREIGN KEY (revision_id, section_id) REFERENCES sections (revision_id, id),
	CHECK ((side = 'file') = (first_line = 0 AND last_line = 0)),
	CHECK (side = 'file' OR (first_line >= 1 AND last_line >= first_line)),
	CHECK ((bucket = 'section') = (section_id IS NOT NULL)),
	CHECK ((bucket = 'ignored') = (ignored_by IS NOT NULL)),
	CHECK ((ignored_by IS NULL) = (ignored_detail IS NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE reviewed_marks (
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new', 'file')),
	first_line INTEGER NOT NULL,
	last_line INTEGER NOT NULL,
	PRIMARY KEY (revision_id, path, side, first_line),
	CHECK ((side = 'file') = (first_line = 0 AND last_line = 0)),
	CHECK (side = 'file' OR (first_line >= 1 AND last_line >= first_line))
) STRICT, WITHOUT ROWID;

-- Snapshots in a store that no revision refers to, and since when, so one left
-- by a crash is removed once the store's grace period has passed.
CREATE TABLE unreferenced_snapshots (
	store_id TEXT NOT NULL,
	snapshot_id TEXT NOT NULL,
	first_seen_at INTEGER NOT NULL,
	PRIMARY KEY (store_id, snapshot_id)
) STRICT, WITHOUT ROWID;
`
	}
];

/** The newest migration this version of diff delver knows. */
export const LATEST_VERSION = MIGRATIONS.reduce((latest, m) => Math.max(latest, m.version), 0);

const RECORD_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	applied_at INTEGER NOT NULL
) STRICT`;

/** Whether the file is ours, someone else's, or new; and what has been applied. */
function inspect(q: Queries, file: Database['file']): Result<readonly number[], DatabaseError> {
	const id = Number(q.get('PRAGMA application_id')?.application_id ?? 0);
	if (id !== APPLICATION_ID) {
		const tables = Number(q.get('SELECT count(*) AS n FROM sqlite_schema')?.n ?? 0);
		// A file with no application id and nothing in it is a new database.
		if (id !== 0 || tables > 0) return err({ kind: 'NotADatabase', file });
		return ok([]);
	}
	return appliedMigrations(q);
}

/** Brings the database's schema up to date, or says why it cannot. */
export function migrate(database: Database, clock: Clock): Result<void, DatabaseError> {
	const latest = LATEST_VERSION;
	for (const migration of MIGRATIONS) {
		const applied = database.write((q): Result<void, DatabaseError> => {
			// Read again inside the write lock, in case another copy of diff delver migrated first.
			const done = inspect(q, database.file);
			if (!done.ok) return done;
			const newest = done.value.reduce((max, v) => Math.max(max, v), 0);
			if (newest > latest) {
				return err({ kind: 'DatabaseTooNew', file: database.file, version: newest, known: latest });
			}
			if (done.value.includes(migration.version)) return ok(undefined);
			q.exec(RECORD_TABLE);
			q.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`);
			q.exec(migration.sql);
			recordMigration(q, migration.version, migration.name, clock.now());
			q.exec(`PRAGMA user_version = ${String(migration.version)}`);
			return ok(undefined);
		});
		if (!applied.ok) return applied;
	}
	return ok(undefined);
}
