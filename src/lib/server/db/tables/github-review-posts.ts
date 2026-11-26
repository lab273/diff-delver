/**
 * The `github_review_posts` table: a Delve's draft being posted to GitHub,
 * as the number of the review it is posted as, written before the review is
 * sent and removed once it is recorded or GitHub refused it. A row that is
 * left means the review may be on GitHub already: its next post looks there
 * first, so it is never posted twice. The only code that sees its rows.
 */
import { z } from 'zod';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { map, ok, type Result } from '#lib/core/result.ts';
import { parseReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseRow, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z.object({ number: whole(parseReviewNumber) });

/** The number of the review of the Delve's draft that may be on GitHub already, if any. */
export function reviewBeingPosted(
	q: Queries,
	report: ReportId
): Result<ReviewNumber | undefined, StoredRowInvalid> {
	const found = q.get(
		'SELECT review_number AS number FROM github_review_posts WHERE report_id = ?',
		report
	);
	return found === undefined
		? ok(undefined)
		: map(parseRow('github_review_posts', row, found), (r) => r.number);
}

/** Notes that review `number` of the Delve is about to be sent to GitHub. */
export function notePosting(
	q: Queries,
	report: ReportId,
	number: ReviewNumber,
	now: Timestamp
): void {
	q.run(
		`INSERT INTO github_review_posts (report_id, review_number, started_at) VALUES (?, ?, ?)
		 ON CONFLICT (report_id) DO UPDATE SET
			review_number = excluded.review_number, started_at = excluded.started_at`,
		report,
		number,
		now
	);
}

/** Forgets the Delve's review being posted: it was recorded, or GitHub refused it. */
export function forgetPosting(q: Queries, report: ReportId): void {
	q.run('DELETE FROM github_review_posts WHERE report_id = ?', report);
}
