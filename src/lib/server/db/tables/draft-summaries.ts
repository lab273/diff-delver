/**
 * The `draft_summaries` table: the overall review of each Delve's draft
 * (`core/review/overall-review.ts`), one row per Delve whose overall review
 * has ever been written. A Delve with no row has none, changed no times. The
 * only code that sees its rows.
 */
import { z } from 'zod';
import { NO_EDITS, parseEditCount } from '#lib/core/edit-count.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import {
	MAX_OVERALL_REVIEW_LENGTH,
	isWritten,
	type OverallReview
} from '#lib/core/review/overall-review.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseRow, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z
	.object({
		body: z.string().max(MAX_OVERALL_REVIEW_LENGTH),
		changedAt: timestamp,
		edits: whole(parseEditCount)
	})
	// Words that are only white space are stored as none.
	.refine(({ body }) => body === '' || isWritten(body))
	.transform(({ body, changedAt, edits }): OverallReview => ({ body, changedAt, edits }));

/** The overall review a Delve that never had one has. */
export const NO_OVERALL_REVIEW: OverallReview = {
	body: '',
	changedAt: undefined,
	edits: NO_EDITS
};

/** The overall review of the Delve's draft. */
export function draftSummaryOf(
	q: Queries,
	report: ReportId
): Result<OverallReview, StoredRowInvalid> {
	const found = q.get(
		'SELECT body, changed_at AS changedAt, edits FROM draft_summaries WHERE report_id = ?',
		report
	);
	return found === undefined ? ok(NO_OVERALL_REVIEW) : parseRow('draft_summaries', row, found);
}

/** Replaces the words of the Delve's overall review, counting the change. */
export function writeDraftSummary(
	q: Queries,
	report: ReportId,
	body: string,
	now: Timestamp
): void {
	q.run(
		`INSERT INTO draft_summaries (report_id, body, changed_at, edits) VALUES (?, ?, ?, 1)
		 ON CONFLICT (report_id) DO UPDATE SET
			body = excluded.body, changed_at = excluded.changed_at, edits = edits + 1`,
		report,
		body,
		now
	);
}
