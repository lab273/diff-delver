/**
 * What can go wrong with diff delver's database, each with a message for the
 * reviewer that says what happened and what to do next.
 */
import type { AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '#lib/core/reviewer-message.tiny.ts';

/** The tables, as named in error messages. */
export type TableName =
	| 'schema_migrations'
	| 'reports'
	| 'revisions'
	| 'sections'
	| 'assignments'
	| 'reviewed_marks'
	| 'unreferenced_snapshots';

/** The file could not be opened or made: a missing folder, no permission, a full disk. */
export interface DatabaseUnusable {
	readonly kind: 'DatabaseUnusable';
	readonly file: AbsolutePath;
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
	readonly version: number;
	/** The newest change this version of diff delver knows. */
	readonly known: number;
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
	| DatabaseBusy
	| StoredRowInvalid
	| DatabaseFailed;

/** What happened and what to do next, for the reviewer. */
export function describeDatabaseError(error: DatabaseError): ReviewerMessage {
	switch (error.kind) {
		case 'DatabaseUnusable':
			return reviewerMessage(
				`diff delver could not open its database ${error.file} (${error.reason}). Check that its folder exists, that you can write to it and that the disk is not full, then try again.`
			);
		case 'NotADatabase':
			return reviewerMessage(
				`${error.file} is not diff delver's database: it is some other file, or a database of another program. Move it out of the way (diff delver will make a new, empty database), or start diff delver with another data folder.`
			);
		case 'DatabaseCorrupt':
			return reviewerMessage(
				`diff delver's database ${error.file} is damaged (${error.reason}). Restore it from a backup if you have one, or move it out of the way to start again with no reports; the snapshots in the data folder are not affected.`
			);
		case 'DatabaseTooNew':
			return reviewerMessage(
				`diff delver's database ${error.file} was last used by a newer version of diff delver (database version ${String(error.version)}; this version knows up to ${String(error.known)}). Update diff delver to the newest version, or start this one with another data folder.`
			);
		case 'DatabaseBusy':
			return reviewerMessage(
				`diff delver's database ${error.file} is being used by another program and did not become free in time. Wait a moment and try again; if it keeps happening, close other copies of diff delver.`
			);
		case 'StoredRowInvalid':
			return reviewerMessage(
				`A saved entry in diff delver's database (table ${error.table}) could not be read: ${error.detail}. The database has been damaged or changed by hand. Delete the affected report, or restore the database from a backup; if it happens again, please report it as a bug.`
			);
		case 'DatabaseFailed':
			return reviewerMessage(
				`diff delver's database ${error.file} failed: ${error.reason}. Try again; if it keeps failing, check that the disk is not full and that the file can be written.`
			);
	}
}
