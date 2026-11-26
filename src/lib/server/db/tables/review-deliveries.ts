/**
 * The `review_deliveries` table: where each finished review was delivered
 * (DESIGN 6.3's delivery log), so far only to GitHub, as one review of its
 * pull request: how it was posted, its address there, how many of its
 * comments went in its text, and when. Written in the transaction that
 * records the review; never changed. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseCommentCount } from '#lib/core/comment-count.tiny.ts';
import type { GitHubReviewId } from '#lib/core/github/github-review-id.tiny.ts';
import { parseGitHubReviewAddress } from '#lib/core/github/github-review-address.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { map, type Result } from '#lib/core/result.ts';
import type { GitHubDelivery } from '#lib/core/review/review-export.ts';
import { parseReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import { parseRows, text, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z.object({
	number: whole(parseReviewNumber),
	postedAs: z.enum(['comment', 'approve', 'request-changes', 'draft']),
	address: text(parseGitHubReviewAddress),
	inText: whole(parseCommentCount),
	at: timestamp
});

/** Where each of the report's reviews was posted on GitHub, by review number. */
export function deliveriesOf(
	q: Queries,
	report: ReportId
): Result<ReadonlyMap<ReviewNumber, GitHubDelivery>, StoredRowInvalid> {
	return map(
		parseRows(
			'review_deliveries',
			row,
			q.all(
				`SELECT review_number AS number, posted_as AS postedAs, address, in_text AS inText,
					delivered_at AS at
				 FROM review_deliveries WHERE report_id = ? AND destination = 'github'`,
				report
			)
		),
		(rows) =>
			new Map(
				rows.map((r) => [
					r.number,
					{ postedAs: r.postedAs, address: r.address, inText: r.inText, at: r.at }
				])
			)
	);
}

/** Records that a finished review was posted to GitHub, beside the review, in its transaction. */
export function insertDelivery(
	q: Queries,
	report: ReportId,
	number: ReviewNumber,
	review: GitHubReviewId,
	delivery: GitHubDelivery
): void {
	q.run(
		`INSERT INTO review_deliveries (report_id, review_number, destination, posted_as,
			github_review_id, address, in_text, delivered_at)
		 VALUES (?, ?, 'github', ?, ?, ?, ?, ?)`,
		report,
		number,
		delivery.postedAs,
		review,
		delivery.address,
		delivery.inText,
		delivery.at
	);
}
