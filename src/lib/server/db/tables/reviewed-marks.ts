/**
 * The `reviewed_marks` table: the units of a revision the reviewer has marked
 * reviewed (DESIGN 5), as runs of units (`storage/stored-units.ts` turns marks
 * into these rows and back). The only code that sees its rows.
 */
import { z } from 'zod';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import type { ReviewedRow } from '#lib/core/storage/stored-units.ts';
import { parseRow } from '../columns.ts';
import type { Queries, RawRow } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { storedUnits, unitColumns, unitValues } from './unit-columns.ts';

const row = z.object(unitColumns);

function toReviewedRow(raw: RawRow): Result<ReviewedRow, StoredRowInvalid> {
	return andThen(parseRow('reviewed_marks', row, raw), (r) =>
		andThen(storedUnits('reviewed_marks', r), (units) => ok({ path: r.path, units }))
	);
}

/** Every reviewed row of a revision, or only of the file at `path`. */
export function reviewedRowsFor(
	q: Queries,
	revision: RevisionId,
	path?: RepoPath
): Result<readonly ReviewedRow[], StoredRowInvalid> {
	const rows: ReviewedRow[] = [];
	for (const raw of q.all(
		'SELECT path, side, first_line, last_line FROM reviewed_marks WHERE revision_id = ?' +
			(path === undefined ? '' : ' AND path = ?'),
		revision,
		...(path === undefined ? [] : [repoPathBytes(path)])
	)) {
		const parsed = toReviewedRow(raw);
		if (!parsed.ok) return parsed;
		rows.push(parsed.value);
	}
	return ok(rows);
}

/** Replaces the rows of the given files of a revision, or of all its files, with `rows`. */
export function replaceReviewedRows(
	q: Queries,
	revision: RevisionId,
	files: ReadonlySet<RepoPath> | 'all',
	rows: readonly ReviewedRow[]
): void {
	if (files === 'all') q.run('DELETE FROM reviewed_marks WHERE revision_id = ?', revision);
	else {
		for (const path of files) {
			q.run(
				'DELETE FROM reviewed_marks WHERE revision_id = ? AND path = ?',
				revision,
				repoPathBytes(path)
			);
		}
	}
	for (const r of rows) {
		q.run(
			'INSERT INTO reviewed_marks (revision_id, path, side, first_line, last_line) VALUES (?, ?, ?, ?, ?)',
			revision,
			...unitValues(r.path, r.units)
		);
	}
}
