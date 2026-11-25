/**
 * The `review_marks` table: a copy of the reviewed marks of a review's
 * revision at the moment the review was finished (DESIGN 6.3), as runs of
 * units shaped like `reviewed_marks`. The only code that sees its rows.
 */
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { ReviewNumber } from '#lib/core/review-number.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import type { ReviewedRow } from '#lib/core/storage/stored-units.ts';
import { z } from 'zod';
import { parseRow } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { storedUnits, unitColumns } from './unit-columns.ts';

const row = z.object(unitColumns);

/** Copies the reviewed marks the revision holds now into the review's. */
export function copyReviewMarks(
	q: Queries,
	report: ReportId,
	number: ReviewNumber,
	revision: RevisionId
): void {
	q.run(
		`INSERT INTO review_marks (report_id, review_number, path, side, first_line, last_line)
		 SELECT ?, ?, path, side, first_line, last_line FROM reviewed_marks WHERE revision_id = ?`,
		report,
		number,
		revision
	);
}

/** The reviewed marks a review recorded, as rows of units. */
export function reviewMarkRowsOf(
	q: Queries,
	report: ReportId,
	number: ReviewNumber
): Result<readonly ReviewedRow[], StoredRowInvalid> {
	const rows: ReviewedRow[] = [];
	for (const raw of q.all(
		`SELECT path, side, first_line, last_line FROM review_marks
		 WHERE report_id = ? AND review_number = ?`,
		report,
		number
	)) {
		const parsed = andThen(
			parseRow('review_marks', row, raw),
			(r): Result<ReviewedRow, StoredRowInvalid> =>
				andThen(storedUnits('review_marks', r), (units) => ok({ path: r.path, units }))
		);
		if (!parsed.ok) return parsed;
		rows.push(parsed.value);
	}
	return ok(rows);
}
