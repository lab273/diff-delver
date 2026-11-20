/**
 * The columns that say which units a row covers, shared by `assignments` and
 * `reviewed_marks`: a path stored as git's exact bytes, a side (`old`, `new`,
 * or `file` for a file-level unit) and a line range (0 to 0 for a file-level
 * unit).
 */
import { z } from 'zod';
import { parseLineRange } from '#lib/core/line-range.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import type { StoredUnits } from '#lib/core/storage/stored-units.ts';
import { integer, repoPath } from '../columns.ts';
import type { StoredRowInvalid, TableName } from '../database-error.ts';

export const unitColumns = {
	path: repoPath,
	side: z.enum(['old', 'new', 'file']),
	first_line: integer,
	last_line: integer
};

/** The units the parsed columns name, or `StoredRowInvalid`. */
export function storedUnits(
	table: TableName,
	columns: { side: 'old' | 'new' | 'file'; first_line: number; last_line: number }
): Result<StoredUnits, StoredRowInvalid> {
	const { side, first_line: first, last_line: last } = columns;
	if (side === 'file') {
		return first === 0 && last === 0
			? ok({ kind: 'file' })
			: err({ kind: 'StoredRowInvalid', table, detail: 'a file-level unit with line numbers' });
	}
	const range = parseLineRange(side, first, last);
	return range.ok
		? ok({ kind: 'lines', range: range.value })
		: err({ kind: 'StoredRowInvalid', table, detail: `lines ${String(first)} to ${String(last)}` });
}

/** The values of the path, side, first and last columns for some units. */
export function unitValues(
	path: RepoPath,
	units: StoredUnits
): readonly [Uint8Array, string, number, number] {
	switch (units.kind) {
		case 'file':
			return [repoPathBytes(path), 'file', 0, 0];
		case 'lines':
			return [repoPathBytes(path), units.range.side, units.range.first, units.range.last];
	}
}
