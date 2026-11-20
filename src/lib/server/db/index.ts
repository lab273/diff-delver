/**
 * diff delver's database (DESIGN 9): `Database.open` opens or makes it in the
 * data directory and brings its schema up to date. Table modules in `tables/`
 * read and write rows inside `read` and `write` transactions.
 */
export type { Queries } from './database.ts';
export { Database, DATABASE_FILE } from './database.ts';
export type {
	DatabaseBusy,
	DatabaseCorrupt,
	DatabaseError,
	DatabaseFailed,
	DatabaseTooNew,
	DatabaseUnusable,
	NotADatabase,
	StoredRowInvalid,
	TableName
} from './database-error.ts';
export { describeDatabaseError } from './database-error.ts';
export { APPLICATION_ID, LATEST_VERSION, MIGRATIONS } from './migrations.ts';
