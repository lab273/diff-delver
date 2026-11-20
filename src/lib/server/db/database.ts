/**
 * diff delver's database (DESIGN 9): one SQLite file in the data directory,
 * beside the stores, opened with Node's built-in `node:sqlite`.
 *
 * Every use goes through `read` or `write`, each one transaction: a `write`
 * whose work returns an error, or throws, changes nothing. `node:sqlite` is
 * synchronous, so the work inside is too; anything slow, such as reading a
 * diff from the store, happens before. Within one process a transaction can
 * therefore never interleave with another, and across processes `write` takes
 * SQLite's write lock at its start (`BEGIN IMMEDIATE`).
 *
 * Only the table modules in `tables/` run SQL on rows; they are the only code
 * that sees a raw row.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	DatabaseSync,
	type SQLInputValue,
	type SQLOutputValue,
	type StatementSync
} from 'node:sqlite';
import { parseAbsolutePath, type AbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import type { Clock } from '#lib/core/clock.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import type { DatabaseError } from './database-error.ts';
import { migrate } from './migrations.ts';

/** The database file's name in the data directory. */
export const DATABASE_FILE = 'diff-delver.sqlite';

/** A row as SQLite returns it. Only the table modules look inside. */
export type RawRow = Readonly<Record<string, SQLOutputValue>>;

/** Running SQL inside one transaction. Valid only while the transaction's work runs. */
export interface Queries {
	/** Runs a statement and says how many rows it changed. */
	run(sql: string, ...params: readonly SQLInputValue[]): number;
	/** Every row a query returns. */
	all(sql: string, ...params: readonly SQLInputValue[]): readonly RawRow[];
	/** The first row a query returns, if any. */
	get(sql: string, ...params: readonly SQLInputValue[]): RawRow | undefined;
	/** Runs several statements with no parameters, such as a migration. */
	exec(sql: string): void;
}

/**
 * The connection settings, each for a single local writer: the daemon, with now
 * and then a second copy of diff delver.
 */
const PRAGMAS = [
	// SQLite leaves foreign keys off by default; the schema relies on them for cascading deletes.
	'PRAGMA foreign_keys = ON',
	// Readers never wait for the writer, and a crash mid-write leaves the last commit intact.
	'PRAGMA journal_mode = WAL',
	// In WAL mode this is still crash-safe; it skips an fsync per commit that only guards power loss.
	'PRAGMA synchronous = NORMAL',
	// A second copy of diff delver writing at the same moment waits up to 5 s instead of failing.
	'PRAGMA busy_timeout = 5000',
	// Views and triggers in a database file never run functions with side effects.
	'PRAGMA trusted_schema = OFF'
];

/** SQLite's primary result codes that diff delver tells apart (the low byte of `errcode`). */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

/** The typed error for something SQLite threw. Anything that is not SQLite's is a bug and is thrown on. */
export function sqliteError(file: AbsolutePath, error: unknown): DatabaseError {
	if (!(error instanceof Error) || !('errcode' in error) || typeof error.errcode !== 'number') {
		throw error;
	}
	const reason =
		'errstr' in error && typeof error.errstr === 'string' ? error.errstr : error.message;
	switch (error.errcode & 0xff) {
		case SQLITE_NOTADB:
			return { kind: 'NotADatabase', file };
		case SQLITE_CORRUPT:
			return { kind: 'DatabaseCorrupt', file, reason };
		case SQLITE_BUSY:
		case SQLITE_LOCKED:
			return { kind: 'DatabaseBusy', file };
		case SQLITE_CANTOPEN:
			return { kind: 'DatabaseUnusable', file, reason };
		default:
			return { kind: 'DatabaseFailed', file, reason };
	}
}

export class Database {
	/** The database file. */
	readonly file: AbsolutePath;
	readonly #connection: DatabaseSync;
	readonly #statements = new Map<string, StatementSync>();
	#inTransaction = false;

	private constructor(file: AbsolutePath, connection: DatabaseSync) {
		this.file = file;
		this.#connection = connection;
	}

	/**
	 * Opens the database in the data directory, making the directory and the file
	 * when they do not exist yet, and brings its schema up to date.
	 */
	static async open(
		dataDirectory: AbsolutePath,
		clock: Clock
	): Promise<Result<Database, DatabaseError>> {
		const file = absolute(join(dataDirectory, DATABASE_FILE));
		try {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
		} catch (error) {
			return err({ kind: 'DatabaseUnusable', file, reason: messageOf(error) });
		}
		let connection: DatabaseSync;
		try {
			connection = new DatabaseSync(file);
		} catch (error) {
			return err(sqliteError(file, error));
		}
		const database = new Database(file, connection);
		try {
			for (const pragma of PRAGMAS) connection.exec(pragma);
		} catch (error) {
			database.close();
			return err(sqliteError(file, error));
		}
		const migrated = migrate(database, clock);
		if (!migrated.ok) {
			database.close();
			return migrated;
		}
		return ok(database);
	}

	/** Runs `work` in one read transaction, so everything it reads is from one moment. */
	read<T, E = never>(work: (q: Queries) => Result<T, E>): Result<T, E | DatabaseError> {
		return this.#transaction('BEGIN', work);
	}

	/**
	 * Runs `work` in one write transaction. When it returns an error or throws,
	 * the transaction is rolled back and the database is as it was.
	 */
	write<T, E = never>(work: (q: Queries) => Result<T, E>): Result<T, E | DatabaseError> {
		return this.#transaction('BEGIN IMMEDIATE', work);
	}

	/** Closes the connection. The database cannot be used afterwards. */
	close(): void {
		if (this.#connection.isOpen) this.#connection.close();
	}

	#transaction<T, E>(
		begin: string,
		work: (q: Queries) => Result<T, E>
	): Result<T, E | DatabaseError> {
		if (this.#inTransaction) throw new Error('A transaction cannot start inside another one.');
		try {
			this.#connection.exec(begin);
		} catch (error) {
			return err(sqliteError(this.file, error));
		}
		this.#inTransaction = true;
		let live = true;
		const statement = (sql: string): StatementSync => {
			if (!live) throw new Error('Queries were used after their transaction ended.');
			let prepared = this.#statements.get(sql);
			if (prepared === undefined) {
				prepared = this.#connection.prepare(sql);
				this.#statements.set(sql, prepared);
			}
			return prepared;
		};
		const queries: Queries = {
			run: (sql, ...params) => Number(statement(sql).run(...params).changes),
			all: (sql, ...params) => statement(sql).all(...params),
			get: (sql, ...params) => statement(sql).get(...params),
			exec: (sql) => {
				if (!live) throw new Error('Queries were used after their transaction ended.');
				this.#connection.exec(sql);
			}
		};
		const rollBack = (): void => {
			try {
				this.#connection.exec('ROLLBACK');
			} catch {
				// SQLite already rolled back, as it does after some errors.
			}
		};
		try {
			const result = work(queries);
			if (!result.ok) {
				rollBack();
				return result;
			}
			this.#connection.exec('COMMIT');
			return result;
		} catch (error) {
			rollBack();
			return err(sqliteError(this.file, error));
		} finally {
			live = false;
			this.#inTransaction = false;
		}
	}
}

function absolute(path: string): AbsolutePath {
	const parsed = parseAbsolutePath(path);
	if (!parsed.ok) throw new Error(`Not an absolute path: ${path}`);
	return parsed.value;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
