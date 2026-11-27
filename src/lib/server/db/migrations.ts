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
import { schemaVersionOf, type SchemaVersion } from '#lib/core/schema-version.tiny.ts';
import type { Database, Queries } from './database.ts';
import type { DatabaseError } from './database-error.ts';
import { appliedMigrations, recordMigration } from './tables/schema-migrations.ts';

/** SQLite's application id for diff delver's database: "dDlv". Marks the file as ours. */
export const APPLICATION_ID = 0x64446c76;

export interface Migration {
	readonly version: SchemaVersion;
	/** What it changes, in a few words. */
	readonly name: string;
	readonly sql: string;
	/**
	 * Set when `sql` rebuilds a table (makes a new one, copies the rows, drops
	 * the old and renames the new), which SQLite requires to change a column's
	 * constraints. It runs with foreign keys off, so dropping the old table
	 * deletes nothing that refers to it, and is checked before it is recorded.
	 */
	readonly rebuildsTables?: true;
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
		version: schemaVersionOf(1),
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
	},
	{
		version: schemaVersionOf(2),
		name: 'reports can be closed because their snapshot is gone',
		rebuildsTables: true,
		sql: `
CREATE TABLE reports_rebuilt (
	id TEXT PRIMARY KEY,
	identity TEXT NOT NULL,
	source_kind TEXT NOT NULL CHECK (source_kind IN ('git')),
	source TEXT NOT NULL,
	store_id TEXT NOT NULL,
	repository_name TEXT NOT NULL,
	repository_path TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
	closed_reason TEXT CHECK (closed_reason IN ('reviewer', 'source-empty', 'snapshot-gone')),
	created_at INTEGER NOT NULL,
	last_activity_at INTEGER NOT NULL,
	CHECK ((state = 'open') = (closed_reason IS NULL))
) STRICT;
INSERT INTO reports_rebuilt (id, identity, source_kind, source, store_id, repository_name, repository_path, state, closed_reason, created_at, last_activity_at)
	SELECT id, identity, source_kind, source, store_id, repository_name, repository_path, state, closed_reason, created_at, last_activity_at FROM reports;
DROP TABLE reports;
ALTER TABLE reports_rebuilt RENAME TO reports;
CREATE UNIQUE INDEX reports_one_open_per_source ON reports (identity) WHERE state = 'open';
CREATE INDEX reports_by_activity ON reports (last_activity_at DESC, created_at DESC);
`
	},
	{
		version: schemaVersionOf(3),
		name: 'what each update of a diff changed, and which changes are new since the version before',
		sql: `
-- One row for each revision an update made (DESIGN 6.2), so its page keeps
-- saying what the update did after a reload. A first revision has none.
CREATE TABLE revision_updates (
	revision_id TEXT PRIMARY KEY REFERENCES revisions (id) ON DELETE CASCADE,
	files_changed INTEGER NOT NULL CHECK (files_changed >= 0),
	files_gone INTEGER NOT NULL CHECK (files_gone >= 0 AND files_gone <= files_changed),
	new_to_review INTEGER NOT NULL CHECK (new_to_review >= 0),
	new_ignored INTEGER NOT NULL CHECK (new_ignored >= 0),
	gone_units INTEGER NOT NULL CHECK (gone_units >= 0),
	reviewed_before INTEGER NOT NULL CHECK (reviewed_before >= 0),
	reviewed_kept INTEGER NOT NULL CHECK (reviewed_kept >= 0 AND reviewed_kept <= reviewed_before)
) STRICT;

-- The units of a revision that the revision before it did not have, as runs
-- of units like reviewed_marks.
CREATE TABLE new_units (
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new', 'file')),
	first_line INTEGER NOT NULL,
	last_line INTEGER NOT NULL,
	PRIMARY KEY (revision_id, path, side, first_line),
	CHECK ((side = 'file') = (first_line = 0 AND last_line = 0)),
	CHECK (side = 'file' OR (first_line >= 1 AND last_line >= first_line))
) STRICT, WITHOUT ROWID;
`
	},
	{
		version: schemaVersionOf(4),
		name: 'revisions to check for changes to a file beside its lines',
		sql: `
-- Revisions written before a file with lines could also have a file-level unit
-- (a change to its name, mode or kind): their rows may lack that unit and their
-- stored progress leave it out. The report service gives each such unit the
-- row a first version would, recomputes the revision's progress from its rows,
-- and removes it from here. Revisions written later are never added.
CREATE TABLE revisions_to_check (
	revision_id TEXT PRIMARY KEY REFERENCES revisions (id) ON DELETE CASCADE
) STRICT;
INSERT INTO revisions_to_check (revision_id) SELECT id FROM revisions;
`
	},
	{
		version: schemaVersionOf(5),
		name: 'which changes an update unmarked because lines close to them changed',
		sql: `
-- The units of a revision that were marked reviewed in the revision before it,
-- are the same lines, and lost their mark because something close to them
-- changed (DESIGN 6.2 step 3), as runs of units like new_units, so the page can
-- say why they are to be read again. Revisions made before this table have none.
CREATE TABLE unmarked_units (
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new', 'file')),
	first_line INTEGER NOT NULL,
	last_line INTEGER NOT NULL,
	PRIMARY KEY (revision_id, path, side, first_line),
	CHECK ((side = 'file') = (first_line = 0 AND last_line = 0)),
	CHECK (side = 'file' OR (first_line >= 1 AND last_line >= first_line))
) STRICT, WITHOUT ROWID;
`
	},
	{
		version: schemaVersionOf(6),
		name: 'how the person likes diffs shown',
		sql: `
-- One row per setting the person has changed, such as code coloured or plain;
-- a setting with no row has its default (core/settings.ts).
CREATE TABLE settings (
	name TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
`
	},
	{
		version: schemaVersionOf(7),
		name: "the agent's overview of each version, and each section's cross-references",
		sql: `
-- What the change does, in reading order, as the agent wrote it (DESIGN 7.1),
-- stored as given and never trusted: it is sanitised when a page shows it.
CREATE TABLE overviews (
	revision_id TEXT PRIMARY KEY REFERENCES revisions (id) ON DELETE CASCADE,
	markdown TEXT NOT NULL
) STRICT;

-- Changed lines that live in another section and matter to this one (DESIGN
-- 4.3), as runs of units like new_units. They affect neither coverage nor ticks.
CREATE TABLE section_references (
	revision_id TEXT NOT NULL,
	section_id TEXT NOT NULL,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new', 'file')),
	first_line INTEGER NOT NULL,
	last_line INTEGER NOT NULL,
	PRIMARY KEY (revision_id, section_id, path, side, first_line),
	FOREIGN KEY (revision_id, section_id) REFERENCES sections (revision_id, id) ON DELETE CASCADE,
	CHECK ((side = 'file') = (first_line = 0 AND last_line = 0)),
	CHECK (side = 'file' OR (first_line >= 1 AND last_line >= first_line))
) STRICT, WITHOUT ROWID;
`
	},
	{
		version: schemaVersionOf(8),
		name: 'how many commits a run of commits is, and the subjects of its oldest and newest',
		sql: `
-- For a report whose source is a run of commits, a range between two commit
-- ids as ticking commits in a list opens it: what its title is made of, read
-- from the repository once when the report is opened, since ids never come to
-- name other commits. A report with no row is titled by its source alone: one
-- of any other source, or opened before this table.
CREATE TABLE commit_runs (
	report_id TEXT PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
	commits INTEGER NOT NULL CHECK (commits >= 1),
	-- The first 200 characters of each subject, as git gives it.
	oldest_subject TEXT NOT NULL,
	newest_subject TEXT NOT NULL
) STRICT;
`
	},
	{
		version: schemaVersionOf(9),
		name: 'private draft comments on lines of a revision',
		sql: `
CREATE TABLE draft_comments (
	id INTEGER PRIMARY KEY,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	body TEXT NOT NULL CHECK (body <> '')
) STRICT;
CREATE INDEX draft_comments_by_revision ON draft_comments (revision_id);
`
	},
	{
		version: schemaVersionOf(10),
		name: 'draft comments whose ids are never used again, with when each was written and changed',
		rebuildsTables: true,
		sql: `
-- A comment's id is never given to another comment once it is deleted
-- (AUTOINCREMENT), so a page that still shows a deleted comment cannot reach
-- a later one by its number. Each says when it was written, when its words
-- were last changed, and how many times they have been, which a page sends
-- back with a change so one made elsewhere since is not overwritten unseen.
-- A comment written before these columns says it was written when its version
-- was taken: the earliest it can have been, since nothing kept the moment.
CREATE TABLE draft_comments_rebuilt (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	body TEXT NOT NULL CHECK (body <> ''),
	written_at INTEGER NOT NULL CHECK (written_at >= 0),
	edited_at INTEGER CHECK (edited_at >= 0),
	edits INTEGER NOT NULL CHECK (edits >= 0),
	CHECK ((edits = 0) = (edited_at IS NULL))
) STRICT;
INSERT INTO draft_comments_rebuilt (id, revision_id, path, side, first_line, last_line, body, written_at, edited_at, edits)
	SELECT c.id, c.revision_id, c.path, c.side, c.first_line, c.last_line, c.body, r.taken_at, NULL, 0
	FROM draft_comments c JOIN revisions r ON r.id = c.revision_id;
DROP TABLE draft_comments;
ALTER TABLE draft_comments_rebuilt RENAME TO draft_comments;
CREATE INDEX draft_comments_by_revision ON draft_comments (revision_id);
`
	},
	{
		version: schemaVersionOf(11),
		name: 'finished reviews, with their comments, the text handed over and what was reviewed',
		sql: `
-- A review the reviewer finished (DESIGN 6.3): numbered 1, 2, 3 within its
-- report, against the revision that was on screen, with the exact text that
-- was handed over and how far the review had got, in units, at that moment.
CREATE TABLE reviews (
	report_id TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
	number INTEGER NOT NULL CHECK (number >= 1),
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	submitted_at INTEGER NOT NULL CHECK (submitted_at >= 0),
	export_text TEXT NOT NULL CHECK (export_text <> ''),
	counted INTEGER NOT NULL CHECK (counted >= 0),
	reviewed INTEGER NOT NULL CHECK (reviewed >= 0 AND reviewed <= counted),
	ignored INTEGER NOT NULL CHECK (ignored >= 0),
	uncategorised INTEGER NOT NULL CHECK (uncategorised >= 0 AND uncategorised <= counted),
	PRIMARY KEY (report_id, number)
) STRICT;
-- Each comment of a finished review, in the order it was written, frozen: the
-- draft comment it was (whose id is never given to another), its lines in the
-- revision it was written on, its words, and the code it is on (a JSON array
-- of at most the first 40 lines) as that revision's snapshot held it.
CREATE TABLE review_comments (
	report_id TEXT NOT NULL,
	review_number INTEGER NOT NULL,
	position INTEGER NOT NULL CHECK (position >= 1),
	draft_comment_id INTEGER NOT NULL CHECK (draft_comment_id >= 1),
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	body TEXT NOT NULL CHECK (body <> ''),
	written_at INTEGER NOT NULL CHECK (written_at >= 0),
	quoted TEXT NOT NULL,
	PRIMARY KEY (report_id, review_number, position),
	FOREIGN KEY (report_id, review_number) REFERENCES reviews (report_id, number) ON DELETE CASCADE
) STRICT;
-- A copy of the reviewed marks of the review's revision when it was finished,
-- shaped like reviewed_marks.
CREATE TABLE review_marks (
	report_id TEXT NOT NULL,
	review_number INTEGER NOT NULL,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new', 'file')),
	first_line INTEGER NOT NULL,
	last_line INTEGER NOT NULL,
	PRIMARY KEY (report_id, review_number, path, side, first_line),
	FOREIGN KEY (report_id, review_number) REFERENCES reviews (report_id, number) ON DELETE CASCADE,
	CHECK ((side = 'file') = (first_line = 0 AND last_line = 0)),
	CHECK (side = 'file' OR (first_line >= 1 AND last_line >= first_line))
) STRICT, WITHOUT ROWID;
CREATE INDEX reviews_by_revision ON reviews (revision_id);
CREATE INDEX review_comments_by_revision ON review_comments (revision_id);
CREATE UNIQUE INDEX review_comments_by_draft ON review_comments (report_id, draft_comment_id);
`
	},
	{
		version: schemaVersionOf(12),
		name: 'the overall review of each draft, and the one each finished review was finished with',
		sql: `
-- The overall review of a Delve's draft (DESIGN 6.3's summary): its words,
-- exactly as typed, or '' once they are emptied, when they last changed, and
-- how many times they have. The count is never reset, not even when a review
-- is finished, so a page that read an older one changes nothing. A Delve with
-- no row has never had one.
CREATE TABLE draft_summaries (
	report_id TEXT PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
	body TEXT NOT NULL,
	changed_at INTEGER NOT NULL CHECK (changed_at >= 0),
	edits INTEGER NOT NULL CHECK (edits >= 1)
) STRICT;
-- The overall review a review was finished with, exactly as typed; '' for none.
ALTER TABLE reviews ADD COLUMN summary TEXT NOT NULL DEFAULT '';
`
	},
	{
		version: schemaVersionOf(13),
		name: 'how many lines of each version are tests, and its binary files with their sizes',
		sql: `
-- Of a revision's lines added and removed, those whose role is 'test' or
-- 'snapshot', kept up to date with the roles as its progress is, so the list,
-- the page and the command count tests apart alike. Counted here, for the
-- revisions saved before, from their rows.
ALTER TABLE revisions ADD COLUMN test_added_lines INTEGER NOT NULL DEFAULT 0 CHECK (test_added_lines >= 0);
ALTER TABLE revisions ADD COLUMN test_deleted_lines INTEGER NOT NULL DEFAULT 0 CHECK (test_deleted_lines >= 0);
UPDATE revisions SET
	test_added_lines = (
		SELECT coalesce(sum(last_line - first_line + 1), 0) FROM assignments AS a
		WHERE a.revision_id = revisions.id AND a.side = 'new' AND a.role IN ('test', 'snapshot')
	),
	test_deleted_lines = (
		SELECT coalesce(sum(last_line - first_line + 1), 0) FROM assignments AS a
		WHERE a.revision_id = revisions.id AND a.side = 'old' AND a.role IN ('test', 'snapshot')
	);
-- The binary files a revision adds, removes and changes, with their sizes in
-- bytes (those removed as they were, those changed before and after), read
-- from the store once. All NULL for a revision saved before, until the report
-- service counts them from its snapshot, after the daemon has started or when
-- the revision is next read, so a start is never held up by it.
ALTER TABLE revisions ADD COLUMN binary_added_files INTEGER CHECK (binary_added_files >= 0);
ALTER TABLE revisions ADD COLUMN binary_added_bytes INTEGER CHECK (binary_added_bytes >= 0);
ALTER TABLE revisions ADD COLUMN binary_removed_files INTEGER CHECK (binary_removed_files >= 0);
ALTER TABLE revisions ADD COLUMN binary_removed_bytes INTEGER CHECK (binary_removed_bytes >= 0);
ALTER TABLE revisions ADD COLUMN binary_changed_files INTEGER CHECK (binary_changed_files >= 0);
ALTER TABLE revisions ADD COLUMN binary_changed_before INTEGER CHECK (binary_changed_before >= 0);
ALTER TABLE revisions ADD COLUMN binary_changed_after INTEGER CHECK (binary_changed_after >= 0);
`
	},
	{
		version: schemaVersionOf(14),
		name: 'reports of GitHub pull requests, with their titles and descriptions',
		rebuildsTables: true,
		sql: `
-- A report's source may be a GitHub pull request (DESIGN 3.1): source_kind
-- 'github', with its address as its source.
CREATE TABLE reports_rebuilt (
	id TEXT PRIMARY KEY,
	identity TEXT NOT NULL,
	source_kind TEXT NOT NULL CHECK (source_kind IN ('git', 'github')),
	source TEXT NOT NULL,
	store_id TEXT NOT NULL,
	repository_name TEXT NOT NULL,
	repository_path TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
	closed_reason TEXT CHECK (closed_reason IN ('reviewer', 'source-empty', 'snapshot-gone')),
	created_at INTEGER NOT NULL,
	last_activity_at INTEGER NOT NULL,
	CHECK ((state = 'open') = (closed_reason IS NULL))
) STRICT;
INSERT INTO reports_rebuilt (id, identity, source_kind, source, store_id, repository_name, repository_path, state, closed_reason, created_at, last_activity_at)
	SELECT id, identity, source_kind, source, store_id, repository_name, repository_path, state, closed_reason, created_at, last_activity_at FROM reports;
DROP TABLE reports;
ALTER TABLE reports_rebuilt RENAME TO reports;
CREATE UNIQUE INDEX reports_one_open_per_source ON reports (identity) WHERE state = 'open';
CREATE INDEX reports_by_activity ON reports (last_activity_at DESC, created_at DESC);
-- For a report of a pull request, its title and description as GitHub gave
-- them when the report was opened or last brought up to date: the title names
-- the report, and the description is given to an agent. NULL for none.
CREATE TABLE pull_requests (
	report_id TEXT PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	description TEXT
) STRICT;
`
	},
	{
		version: schemaVersionOf(15),
		name: 'where each finished review was delivered, and reviews being posted to GitHub',
		sql: `
-- The delivery log of a finished review (DESIGN 6.3), so far its posting to
-- GitHub: the review GitHub made of it, its address there (always made from
-- the pull request and the review's id), how it was posted ('comment',
-- 'approve', 'request-changes', or 'draft', a pending review the reviewer
-- submits on GitHub), how many of its comments went in its text, and when.
CREATE TABLE review_deliveries (
	report_id TEXT NOT NULL,
	review_number INTEGER NOT NULL,
	destination TEXT NOT NULL CHECK (destination IN ('github')),
	posted_as TEXT NOT NULL CHECK (posted_as IN ('comment', 'approve', 'request-changes', 'draft')),
	github_review_id INTEGER NOT NULL CHECK (github_review_id >= 1),
	address TEXT NOT NULL CHECK (address LIKE 'https://%'),
	in_text INTEGER NOT NULL CHECK (in_text >= 0),
	delivered_at INTEGER NOT NULL CHECK (delivered_at >= 0),
	PRIMARY KEY (report_id, review_number, destination),
	FOREIGN KEY (report_id, review_number) REFERENCES reviews (report_id, number) ON DELETE CASCADE
) STRICT;
-- A review of the draft that is being posted to GitHub, written before it is
-- sent and removed once it is recorded or GitHub refused it: the number it is
-- posted as, the secret part of the mark its text ends with, made for this
-- post so nobody can know it beforehand, and exactly what was sent, as the
-- review would record it: the
-- revision, the text handed over, how far the review had got, the overall
-- review and how many times its words had been changed, how it was asked to
-- be posted, whether every comment went in its text (as when GitHub refused
-- their lines and it was sent again) and how many did. A row left by a daemon
-- stopped while posting, or by GitHub not answering, means it may be on
-- GitHub already, so the next finish of that number looks for its mark there
-- first, never posts it twice, and records what was sent, not the draft as it
-- is by then.
CREATE TABLE github_review_posts (
	report_id TEXT PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
	review_number INTEGER NOT NULL CHECK (review_number >= 1),
	mark TEXT NOT NULL CHECK (length(mark) = 32),
	started_at INTEGER NOT NULL CHECK (started_at >= 0),
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	export_text TEXT NOT NULL CHECK (export_text <> ''),
	counted INTEGER NOT NULL CHECK (counted >= 0),
	reviewed INTEGER NOT NULL CHECK (reviewed >= 0 AND reviewed <= counted),
	ignored INTEGER NOT NULL CHECK (ignored >= 0),
	uncategorised INTEGER NOT NULL CHECK (uncategorised >= 0 AND uncategorised <= counted),
	summary TEXT NOT NULL,
	summary_edits INTEGER NOT NULL CHECK (summary_edits >= 0),
	posted_as TEXT NOT NULL CHECK (posted_as IN ('comment', 'approve', 'request-changes', 'draft')),
	all_in_text INTEGER NOT NULL CHECK (all_in_text IN (0, 1)),
	in_text INTEGER NOT NULL CHECK (in_text >= 0)
) STRICT;
-- The comments of a review being posted, as review_comments will hold them,
-- each with how many times its words had been changed when it was sent, so
-- a comment changed since stays in the draft.
CREATE TABLE github_review_post_comments (
	report_id TEXT NOT NULL REFERENCES github_review_posts (report_id) ON DELETE CASCADE,
	position INTEGER NOT NULL CHECK (position >= 1),
	draft_comment_id INTEGER NOT NULL CHECK (draft_comment_id >= 1),
	edits INTEGER NOT NULL CHECK (edits >= 0),
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	body TEXT NOT NULL CHECK (body <> ''),
	written_at INTEGER NOT NULL CHECK (written_at >= 0),
	quoted TEXT NOT NULL,
	PRIMARY KEY (report_id, position)
) STRICT;
-- The reviewed marks of a review being posted, as they were when it was sent,
-- shaped like review_marks.
CREATE TABLE github_review_post_marks (
	report_id TEXT NOT NULL REFERENCES github_review_posts (report_id) ON DELETE CASCADE,
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new', 'file')),
	first_line INTEGER NOT NULL,
	last_line INTEGER NOT NULL,
	PRIMARY KEY (report_id, path, side, first_line),
	CHECK ((side = 'file') = (first_line = 0 AND last_line = 0)),
	CHECK (side = 'file' OR (first_line >= 1 AND last_line >= first_line))
) STRICT, WITHOUT ROWID;
CREATE INDEX github_review_posts_by_revision ON github_review_posts (revision_id);
CREATE INDEX github_review_post_comments_by_revision ON github_review_post_comments (revision_id);
`
	},
	{
		version: schemaVersionOf(16),
		name: 'flags on lines, beside comments, in the draft and in finished reviews',
		rebuildsTables: true,
		sql: `
-- A thread of the draft is a comment or a flag (DESIGN 5): a flag is the
-- reviewer's "look at this again" on lines, whose words are optional, so
-- only a comment must have some. The same kind is kept by a finished review
-- and by a review being posted. Every row before was a comment.
CREATE TABLE draft_comments_rebuilt (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('comment', 'flag')),
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	body TEXT NOT NULL CHECK (kind = 'flag' OR body <> ''),
	written_at INTEGER NOT NULL CHECK (written_at >= 0),
	edited_at INTEGER CHECK (edited_at >= 0),
	edits INTEGER NOT NULL CHECK (edits >= 0),
	CHECK ((edits = 0) = (edited_at IS NULL))
) STRICT;
INSERT INTO draft_comments_rebuilt (id, revision_id, kind, path, side, first_line, last_line, body, written_at, edited_at, edits)
	SELECT id, revision_id, 'comment', path, side, first_line, last_line, body, written_at, edited_at, edits
	FROM draft_comments;
-- An id is never given out again, so the count goes on from where it was,
-- past comments deleted since the last one kept.
DELETE FROM sqlite_sequence WHERE name = 'draft_comments_rebuilt';
INSERT INTO sqlite_sequence (name, seq)
	SELECT 'draft_comments_rebuilt', seq FROM sqlite_sequence WHERE name = 'draft_comments';
DROP TABLE draft_comments;
ALTER TABLE draft_comments_rebuilt RENAME TO draft_comments;
CREATE INDEX draft_comments_by_revision ON draft_comments (revision_id);

CREATE TABLE review_comments_rebuilt (
	report_id TEXT NOT NULL,
	review_number INTEGER NOT NULL,
	position INTEGER NOT NULL CHECK (position >= 1),
	draft_comment_id INTEGER NOT NULL CHECK (draft_comment_id >= 1),
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('comment', 'flag')),
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	body TEXT NOT NULL CHECK (kind = 'flag' OR body <> ''),
	written_at INTEGER NOT NULL CHECK (written_at >= 0),
	quoted TEXT NOT NULL,
	PRIMARY KEY (report_id, review_number, position),
	FOREIGN KEY (report_id, review_number) REFERENCES reviews (report_id, number) ON DELETE CASCADE
) STRICT;
INSERT INTO review_comments_rebuilt (report_id, review_number, position, draft_comment_id, revision_id, kind, path, side, first_line, last_line, body, written_at, quoted)
	SELECT report_id, review_number, position, draft_comment_id, revision_id, 'comment', path, side, first_line, last_line, body, written_at, quoted
	FROM review_comments;
DROP TABLE review_comments;
ALTER TABLE review_comments_rebuilt RENAME TO review_comments;
CREATE INDEX review_comments_by_revision ON review_comments (revision_id);
CREATE UNIQUE INDEX review_comments_by_draft ON review_comments (report_id, draft_comment_id);

CREATE TABLE github_review_post_comments_rebuilt (
	report_id TEXT NOT NULL REFERENCES github_review_posts (report_id) ON DELETE CASCADE,
	position INTEGER NOT NULL CHECK (position >= 1),
	draft_comment_id INTEGER NOT NULL CHECK (draft_comment_id >= 1),
	edits INTEGER NOT NULL CHECK (edits >= 0),
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('comment', 'flag')),
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	body TEXT NOT NULL CHECK (kind = 'flag' OR body <> ''),
	written_at INTEGER NOT NULL CHECK (written_at >= 0),
	quoted TEXT NOT NULL,
	PRIMARY KEY (report_id, position)
) STRICT;
INSERT INTO github_review_post_comments_rebuilt (report_id, position, draft_comment_id, edits, revision_id, kind, path, side, first_line, last_line, body, written_at, quoted)
	SELECT report_id, position, draft_comment_id, edits, revision_id, 'comment', path, side, first_line, last_line, body, written_at, quoted
	FROM github_review_post_comments;
DROP TABLE github_review_post_comments;
ALTER TABLE github_review_post_comments_rebuilt RENAME TO github_review_post_comments;
CREATE INDEX github_review_post_comments_by_revision ON github_review_post_comments (revision_id);
`
	},
	{
		version: schemaVersionOf(17),
		name: "agent notes on lines, apart from the reviewer's draft",
		sql: `
-- An agent note (DESIGN 5) is the agent's, never the reviewer's: it is kept
-- apart from the draft, so nothing that reads the draft or a finished review
-- can read one. It belongs to the version it was written on. The reviewer
-- only dismisses one, or promotes it, which copies it into the draft as a
-- comment of their own.
CREATE TABLE agent_notes (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	label TEXT NOT NULL CHECK (label IN ('possible bug', 'risk', 'question', 'info')),
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	body TEXT NOT NULL CHECK (body <> ''),
	written_at INTEGER NOT NULL CHECK (written_at >= 0),
	state TEXT NOT NULL CHECK (state IN ('waiting', 'dismissed', 'promoted'))
) STRICT;
CREATE INDEX agent_notes_by_revision ON agent_notes (revision_id);
`
	},
	{
		version: schemaVersionOf(18),
		name: "each section's reading order, its steps with the agent's notes",
		sql: `
-- A section's reading order (DESIGN 4.3.1): its steps in order, each some of
-- one file's change units in the section, with the agent's note on it, stored
-- as given and sanitised when a page shows it. A section with no rows reads
-- in path order. The steps never share a unit.
CREATE TABLE reading_steps (
	revision_id TEXT NOT NULL,
	section_id TEXT NOT NULL,
	position INTEGER NOT NULL CHECK (position >= 0),
	path BLOB NOT NULL,
	note TEXT CHECK (note IS NULL OR note <> ''),
	PRIMARY KEY (revision_id, section_id, position),
	FOREIGN KEY (revision_id, section_id) REFERENCES sections (revision_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- The change units of each step's file, as runs of units like new_units.
CREATE TABLE reading_step_units (
	revision_id TEXT NOT NULL,
	section_id TEXT NOT NULL,
	position INTEGER NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new', 'file')),
	first_line INTEGER NOT NULL,
	last_line INTEGER NOT NULL,
	PRIMARY KEY (revision_id, section_id, position, side, first_line),
	FOREIGN KEY (revision_id, section_id, position)
		REFERENCES reading_steps (revision_id, section_id, position) ON DELETE CASCADE,
	CHECK ((side = 'file') = (first_line = 0 AND last_line = 0)),
	CHECK (side = 'file' OR (first_line >= 1 AND last_line >= first_line))
) STRICT, WITHOUT ROWID;
`
	},
	{
		version: schemaVersionOf(19),
		name: "which of the agent's overview and section summaries the reviewer has read",
		sql: `
-- The reviewer's, never the agent's (DESIGN 8.1): one row for each text of the
-- agent's overview (an empty section id) or of a section's summary that the
-- reviewer has read in a Delve, by a hash of the text. A text read is read in
-- every version that has the same one, and a rewritten one is unread again.
CREATE TABLE summaries_read (
	report_id TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
	section_id TEXT NOT NULL,
	text_hash TEXT NOT NULL CHECK (length(text_hash) = 64),
	PRIMARY KEY (report_id, section_id, text_hash)
) STRICT, WITHOUT ROWID;
`
	},
	{
		version: schemaVersionOf(20),
		name: "the reviewer's requests to the agent and its answers",
		sql: `
-- The reviewer's questions to the agent (DESIGN 5 request, 7.2): conversation,
-- not feedback, so nothing that reads the draft or a finished review reads
-- them. Each belongs to the version it was asked on and is about lines of a
-- file (by the diff's path for it), a whole file, or a section.
CREATE TABLE agent_requests (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	about TEXT NOT NULL CHECK (about IN ('lines', 'file', 'section')),
	path BLOB,
	side TEXT CHECK (side IN ('old', 'new')),
	first_line INTEGER CHECK (first_line >= 1),
	last_line INTEGER CHECK (last_line >= first_line),
	section_id TEXT,
	section_title TEXT,
	question TEXT NOT NULL CHECK (question <> ''),
	asked_at INTEGER NOT NULL CHECK (asked_at >= 0),
	status TEXT NOT NULL CHECK (status IN ('waiting', 'delivered', 'answered', 'cancelled')),
	promoted INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0, 1)),
	CHECK ((about = 'section') = (section_id IS NOT NULL AND section_title IS NOT NULL)),
	CHECK ((about = 'section') = (path IS NULL)),
	CHECK ((about = 'lines') = (side IS NOT NULL AND first_line IS NOT NULL AND last_line IS NOT NULL))
) STRICT;
CREATE INDEX agent_requests_by_revision ON agent_requests (revision_id);

-- The agent's answers, its words as given, sanitised when a page shows them,
-- each on the revision it was written on.
CREATE TABLE request_answers (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	request_id INTEGER NOT NULL REFERENCES agent_requests (id) ON DELETE CASCADE,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	body TEXT NOT NULL CHECK (body <> ''),
	answered_at INTEGER NOT NULL CHECK (answered_at >= 0)
) STRICT;
CREATE INDEX request_answers_by_request ON request_answers (request_id);

-- The code each answer pointed at: the agent gave only a path and lines, and
-- the lines are read from the answer's snapshot, a JSON array of at most the
-- lines drawn, as review_comments keeps the code a comment is on.
CREATE TABLE request_answer_excerpts (
	answer_id INTEGER NOT NULL REFERENCES request_answers (id) ON DELETE CASCADE,
	position INTEGER NOT NULL CHECK (position >= 0),
	path BLOB NOT NULL,
	side TEXT NOT NULL CHECK (side IN ('old', 'new')),
	first_line INTEGER NOT NULL CHECK (first_line >= 1),
	last_line INTEGER NOT NULL CHECK (last_line >= first_line),
	lines TEXT NOT NULL,
	PRIMARY KEY (answer_id, position)
) STRICT, WITHOUT ROWID;
`
	},
	{
		version: schemaVersionOf(21),
		name: "threads: finished reviews' comments followed through later versions, replied to and resolved",
		sql: `
-- A thread (DESIGN 6.3) is what a finished review's comment or flag becomes:
-- the Delve's, not the review's, followed to its lines in every later
-- version. It starts with that comment (its review and place in it); a reply
-- in a later review is a comment of that review that names the thread it
-- answers (reply_to), as a reply in the draft is a draft comment that does.
CREATE TABLE threads (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	report_id TEXT NOT NULL,
	review_number INTEGER NOT NULL,
	position INTEGER NOT NULL,
	UNIQUE (report_id, review_number, position),
	FOREIGN KEY (report_id, review_number, position)
		REFERENCES review_comments (report_id, review_number, position) ON DELETE CASCADE
) STRICT;
ALTER TABLE review_comments ADD COLUMN reply_to INTEGER REFERENCES threads (id) ON DELETE CASCADE;
ALTER TABLE draft_comments ADD COLUMN reply_to INTEGER REFERENCES threads (id) ON DELETE CASCADE;
ALTER TABLE github_review_post_comments ADD COLUMN reply_to INTEGER REFERENCES threads (id) ON DELETE CASCADE;
CREATE INDEX review_comments_by_thread ON review_comments (reply_to) WHERE reply_to IS NOT NULL;

-- Where a thread's lines are in each version it has been followed to, from
-- the one its first comment is on: NULL lines when they are gone. edited
-- says whether its code changed since the version it was followed from.
CREATE TABLE thread_places (
	thread_id INTEGER NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	path BLOB,
	side TEXT CHECK (side IN ('old', 'new')),
	first_line INTEGER CHECK (first_line >= 1),
	last_line INTEGER CHECK (last_line >= first_line),
	edited INTEGER NOT NULL CHECK (edited IN (0, 1)),
	PRIMARY KEY (thread_id, revision_id),
	CHECK ((path IS NULL) = (side IS NULL)),
	CHECK ((path IS NULL) = (first_line IS NULL)),
	CHECK ((path IS NULL) = (last_line IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX thread_places_by_revision ON thread_places (revision_id);

-- A thread resolved (1) or opened again (0) in the draft, on the version
-- shown then: part of the draft, finished with it.
CREATE TABLE draft_resolutions (
	thread_id INTEGER PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	resolved INTEGER NOT NULL CHECK (resolved IN (0, 1))
) STRICT;
-- The same, as a finished review did it.
CREATE TABLE review_resolutions (
	report_id TEXT NOT NULL,
	review_number INTEGER NOT NULL,
	thread_id INTEGER NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
	PRIMARY KEY (report_id, review_number, thread_id),
	FOREIGN KEY (report_id, review_number) REFERENCES reviews (report_id, number) ON DELETE CASCADE
) STRICT;
-- And as a review being posted to GitHub sent it.
CREATE TABLE github_review_post_resolutions (
	report_id TEXT NOT NULL REFERENCES github_review_posts (report_id) ON DELETE CASCADE,
	thread_id INTEGER NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
	revision_id TEXT NOT NULL REFERENCES revisions (id) ON DELETE CASCADE,
	resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
	PRIMARY KEY (report_id, thread_id)
) STRICT;
CREATE INDEX draft_resolutions_by_revision ON draft_resolutions (revision_id);
CREATE INDEX review_resolutions_by_thread ON review_resolutions (thread_id);

-- Every comment and flag of the reviews finished before starts a thread, on
-- its lines in its own version; later versions follow it when they are shown.
INSERT INTO threads (report_id, review_number, position)
	SELECT report_id, review_number, position FROM review_comments
	ORDER BY report_id, review_number, position;
INSERT INTO thread_places (thread_id, revision_id, path, side, first_line, last_line, edited)
	SELECT t.id, c.revision_id, c.path, c.side, c.first_line, c.last_line, 0
	FROM threads t JOIN review_comments c
		ON c.report_id = t.report_id AND c.review_number = t.review_number AND c.position = t.position;
`
	}
];

/** The newest migration this version of diff delver knows. */
export const LATEST_VERSION: SchemaVersion = newestOf(MIGRATIONS.map((m) => m.version));

/** The newest of some versions; 1 when there are none. */
export function newestOf(versions: readonly SchemaVersion[]): SchemaVersion {
	return versions.reduce((newest, v) => (v > newest ? v : newest), schemaVersionOf(1));
}

const RECORD_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	applied_at INTEGER NOT NULL
) STRICT`;

/** Whether the file is ours, someone else's, or new; and what has been applied. */
export function inspect(
	q: Queries,
	file: Database['file']
): Result<readonly SchemaVersion[], DatabaseError> {
	const id = Number(q.get('PRAGMA application_id')?.application_id ?? 0);
	if (id !== APPLICATION_ID) {
		const tables = Number(q.get('SELECT count(*) AS n FROM sqlite_schema')?.n ?? 0);
		// A file with no application id and nothing in it is a new database.
		if (id !== 0 || tables > 0) return err({ kind: 'NotADatabase', file });
		return ok([]);
	}
	return appliedMigrations(q);
}

/**
 * Brings the database's schema up to date with `migrations`, oldest first, or
 * says why it cannot. A migration that fails changes nothing, so the file stays
 * at the version before it.
 */
export function migrate(
	database: Database,
	clock: Clock,
	migrations: readonly Migration[] = MIGRATIONS
): Result<void, DatabaseError> {
	const latest = newestOf(migrations.map((m) => m.version));
	for (const migration of migrations) {
		const apply = (): Result<void, DatabaseError> =>
			database.write((q): Result<void, DatabaseError> => {
				// Read again inside the write lock, in case another copy of diff delver migrated first.
				const done = inspect(q, database.file);
				if (!done.ok) return done;
				const newest = newestOf(done.value);
				if (newest > latest) {
					return err({
						kind: 'DatabaseTooNew',
						file: database.file,
						version: newest,
						known: latest
					});
				}
				if (done.value.includes(migration.version)) return ok(undefined);
				q.exec(RECORD_TABLE);
				q.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`);
				try {
					q.exec(migration.sql);
				} catch (error) {
					return err({
						kind: 'MigrationFailed',
						file: database.file,
						version: migration.version,
						reason: error instanceof Error ? error.message : String(error)
					});
				}
				if (migration.rebuildsTables === true) {
					const broken = q.all('PRAGMA foreign_key_check');
					if (broken.length > 0) {
						return err({
							kind: 'MigrationFailed',
							file: database.file,
							version: migration.version,
							reason: `it left ${String(broken.length)} rows referring to rows that are gone`
						});
					}
				}
				recordMigration(q, migration.version, migration.name, clock.now());
				q.exec(`PRAGMA user_version = ${String(migration.version)}`);
				return ok(undefined);
			});
		const applied =
			migration.rebuildsTables === true ? database.withForeignKeysOff(apply) : apply();
		if (!applied.ok) return applied;
	}
	return ok(undefined);
}
