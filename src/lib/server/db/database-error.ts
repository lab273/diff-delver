/**
 * What can go wrong with diff delver's database, each with a message for the
 * reviewer that says what happened and what to do next.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { SchemaVersion } from '#lib/core/schema-version.tiny.ts';

/** The tables, as named in error messages. */
export type TableName =
	| 'schema_migrations'
	| 'reports'
	| 'revisions'
	| 'sections'
	| 'assignments'
	| 'reviewed_marks'
	| 'revision_updates'
	| 'new_units'
	| 'unmarked_units'
	| 'revisions_to_check'
	| 'unreferenced_snapshots'
	| 'settings'
	| 'overviews'
	| 'section_references'
	| 'commit_runs'
	| 'draft_comments';

/**
 * The file could not be opened or made (a missing folder, no permission, a full
 * disk), or it can be read but not written.
 */
export interface DatabaseUnusable {
	readonly kind: 'DatabaseUnusable';
	readonly file: AbsolutePath;
	readonly problem: 'cannot-open' | 'read-only' | 'disk-full';
	readonly reason: string;
}

/** The file exists but is not an SQLite database, or is one that belongs to another program. */
export interface NotADatabase {
	readonly kind: 'NotADatabase';
	readonly file: AbsolutePath;
}

/** SQLite found the file damaged. */
export interface DatabaseCorrupt {
	readonly kind: 'DatabaseCorrupt';
	readonly file: AbsolutePath;
	readonly reason: string;
}

/** A newer version of diff delver has changed the database in ways this one does not know. */
export interface DatabaseTooNew {
	readonly kind: 'DatabaseTooNew';
	readonly file: AbsolutePath;
	/** The newest change the database has. */
	readonly version: SchemaVersion;
	/** The newest change this version of diff delver knows. */
	readonly known: SchemaVersion;
}

/** A change to the database's schema failed, so it was not made. */
export interface MigrationFailed {
	readonly kind: 'MigrationFailed';
	readonly file: AbsolutePath;
	/** The change that failed. */
	readonly version: SchemaVersion;
	readonly reason: string;
}

/** Another program held the database for longer than the busy timeout. */
export interface DatabaseBusy {
	readonly kind: 'DatabaseBusy';
	readonly file: AbsolutePath;
}

/** A stored row does not hold what its table should. */
export interface StoredRowInvalid {
	readonly kind: 'StoredRowInvalid';
	readonly table: TableName;
	readonly detail: string;
}

/** SQLite failed in some other way. */
export interface DatabaseFailed {
	readonly kind: 'DatabaseFailed';
	readonly file: AbsolutePath;
	readonly reason: string;
}

export type DatabaseError =
	| DatabaseUnusable
	| NotADatabase
	| DatabaseCorrupt
	| DatabaseTooNew
	| MigrationFailed
	| DatabaseBusy
	| StoredRowInvalid
	| DatabaseFailed;

/** What happened and what to do next, for the reviewer. */
export function describeDatabaseError(error: DatabaseError): ReviewerMessage {
	switch (error.kind) {
		case 'DatabaseUnusable':
			return unusable(error);
		case 'NotADatabase':
			return reviewerMessage(
				`${error.file} is not diff delver's database: it is some other file, or a database of another program. Move it out of the way (diff delver will make a new, empty database), or start diff delver with another data folder.`
			);
		case 'DatabaseCorrupt':
			return reviewerMessage(
				`diff delver's database ${error.file} is damaged (${error.reason}). Restore it from a backup if you have one, or move it out of the way to start again with no Delves; the saved changes in the data folder are not affected.`
			);
		case 'DatabaseTooNew':
			return reviewerMessage(
				`diff delver's database ${error.file} was last used by a newer version of diff delver (database version ${String(error.version)}; this version knows up to ${String(error.known)}). Update diff delver to the newest version, or start this one with another data folder.`
			);
		case 'MigrationFailed':
			return reviewerMessage(
				`diff delver could not bring its database ${error.file} up to date (change ${String(error.version)} failed: ${error.reason}). The database is as it was, so your Delves are safe. Please report this as a bug; until it is fixed, use the version of diff delver you used before.`
			);
		case 'DatabaseBusy':
			return reviewerMessage(
				`diff delver's database ${error.file} is being used by another program and did not become free in time. Wait a moment and try again; if it keeps happening, close other copies of diff delver.`
			);
		case 'StoredRowInvalid':
			return reviewerMessage(
				`A saved entry in diff delver's database (${tableInWords(error.table)}) could not be read: the database has been damaged or changed by hand. ${storedRowAdvice(error.table)} If it happens again, please report it as a bug.`
			);
		case 'DatabaseFailed':
			return reviewerMessage(
				`diff delver's database ${error.file} failed: ${error.reason}. Nothing was half saved. Try again; if it keeps failing, please report it as a bug.`
			);
	}
}

function unusable(error: DatabaseUnusable): ReviewerMessage {
	switch (error.problem) {
		case 'read-only':
			return reviewerMessage(
				`diff delver can read its database ${error.file} but cannot write to it: the file or its folder is read-only. Make both writable for yourself (for example with "chmod u+w" on each), or start diff delver with another data folder.`
			);
		case 'disk-full':
			return reviewerMessage(
				`diff delver could not save to its database ${error.file}: the disk that holds it is full. Free some space on it, then try again; nothing was half saved.`
			);
		case 'cannot-open':
			return reviewerMessage(
				`diff delver could not open its database ${error.file} (${error.reason}). Check that its folder exists, that you can write to it and that the disk is not full, then try again.`
			);
	}
}

/** What a table holds, in the reviewer's words. */
function tableInWords(table: TableName): string {
	switch (table) {
		case 'reports':
			return 'a Delve’s details';
		case 'revisions':
			return 'a saved version of a Delve';
		case 'sections':
			return 'a Delve’s sections';
		case 'assignments':
			return 'which section each change is in';
		case 'reviewed_marks':
			return 'what you marked as reviewed';
		case 'revision_updates':
			return 'what an update of a Delve changed';
		case 'new_units':
			return 'which changes are new since a Delve’s previous version';
		case 'unmarked_units':
			return 'which changes an update unmarked because lines close to them changed';
		case 'revisions_to_check':
			return 'the list of Delves saved by an earlier diff delver still to bring up to date';
		case 'schema_migrations':
			return 'the record of the database’s own version';
		case 'unreferenced_snapshots':
			return 'the list of saved changes to remove';
		case 'settings':
			return 'how you like diffs shown';
		case 'overviews':
			return 'the agent’s overview of a Delve';
		case 'section_references':
			return 'which lines a Delve’s sections point to in other sections';
		case 'draft_comments':
			return 'a Delve’s draft comments';
		case 'commit_runs':
			return 'which commits a diff of several commits is named after';
	}
}

/** What to do about a damaged row: delete its report where it has one, or deal with the file. */
function storedRowAdvice(table: TableName): string {
	switch (table) {
		case 'reports':
		case 'revisions':
		case 'sections':
		case 'assignments':
		case 'reviewed_marks':
		case 'revision_updates':
		case 'new_units':
		case 'unmarked_units':
		case 'revisions_to_check':
		case 'overviews':
		case 'section_references':
		case 'commit_runs':
			return 'Delete that Delve from the list of Delves, where it shows as damaged, or restore the database from a backup.';
		case 'draft_comments':
			return 'Restore the database from a backup to recover the draft comments.';
		case 'settings':
			return 'Change any setting on a Delve’s page, which stores it again.';
		case 'schema_migrations':
		case 'unreferenced_snapshots':
			return 'Restore the database from a backup, or move it out of the way to start again with no Delves; the saved changes in the data folder are not affected.';
	}
}
