/**
 * Zod schemas for the columns the table modules read: each turns what SQLite
 * returns into a domain value with that value's own parse function, so a row
 * that does not hold what its table should fails to parse instead of passing a
 * bad value on. `parseRow` turns such a failure into a `StoredRowInvalid` that
 * names the table.
 */
import { z } from 'zod';
import { repoPathFromBytes } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { parseTimestamp, type Timestamp } from '#lib/core/timestamp.tiny.ts';
import type { RawRow } from './database.ts';
import type { StoredRowInvalid, TableName } from './database-error.ts';

/** A column holding a value that `parse` turns into a domain value. */
export function parsed<I, T>(
	base: z.ZodType<I>,
	parse: (value: I) => Result<T, unknown>
): z.ZodType<T> {
	return base.transform((value, context) => {
		const result = parse(value);
		if (result.ok) return result.value;
		context.addIssue({ code: 'custom', message: `${JSON.stringify(value)} is not valid here` });
		return z.NEVER;
	});
}

/** A whole number, as SQLite returns an INTEGER. */
export const integer = z.number().int();

/** A TEXT column holding a domain value. */
export function text<T>(parse: (value: string) => Result<T, unknown>): z.ZodType<T> {
	return parsed(z.string(), parse);
}

/** An INTEGER column holding a domain value. */
export function whole<T>(parse: (value: number) => Result<T, unknown>): z.ZodType<T> {
	return parsed(integer, parse);
}

/** A nullable column: SQL NULL reads as undefined. */
export function nullable<T>(schema: z.ZodType<T>): z.ZodType<T | undefined> {
	return z.union([z.null().transform(() => undefined), schema]);
}

/** A moment, stored as whole milliseconds since 1970 UTC. */
export const timestamp: z.ZodType<Timestamp> = whole(parseTimestamp);

/** A path inside a tree, stored as a BLOB of git's exact bytes. */
export const repoPath: z.ZodType<RepoPath> = parsed(z.instanceof(Uint8Array), repoPathFromBytes);

/** The row parsed with the table's schema, or `StoredRowInvalid` naming the table. */
export function parseRow<T>(
	table: TableName,
	schema: z.ZodType<T>,
	row: RawRow
): Result<T, StoredRowInvalid> {
	const result = schema.safeParse(row);
	if (result.success) return ok(result.data);
	const issue = result.error.issues[0];
	const column = issue?.path.join('.') ?? '';
	return err({
		kind: 'StoredRowInvalid',
		table,
		detail: `column ${column === '' ? '(row)' : column}: ${issue?.message ?? 'invalid'}`
	});
}

/** Every row parsed, or the first failure. */
export function parseRows<T>(
	table: TableName,
	schema: z.ZodType<T>,
	rows: readonly RawRow[]
): Result<readonly T[], StoredRowInvalid> {
	const values: T[] = [];
	for (const row of rows) {
		const value = parseRow(table, schema, row);
		if (!value.ok) return value;
		values.push(value.value);
	}
	return ok(values);
}
