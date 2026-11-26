/**
 * The `reviews` table: the reviews the reviewer finished (DESIGN 6.3), each
 * numbered within its report, with the revision it was finished on, the exact
 * text that was handed over, the overall review it was finished with, and how
 * far the review had got then. A review is
 * never changed once it is written. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseCommentCount } from '#lib/core/comment-count.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { andThen, err, map, ok, type Result } from '#lib/core/result.ts';
import type { FinishedReview } from '#lib/core/review/review-export.ts';
import { parseReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { textForAgent, type TextForAgent } from '#lib/core/text-for-agent.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import type { UnitProgress } from '#lib/core/reports/report.ts';
import { parseUnitCount } from '#lib/core/unit-count.tiny.ts';
import { nullable, parseRow, parseRows, text, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { deliveriesOf } from './review-deliveries.ts';

const row = z
	.object({
		number: whole(parseReviewNumber),
		version: whole(parseRevisionNumber),
		submittedAt: timestamp,
		counted: whole(parseUnitCount),
		reviewed: whole(parseUnitCount),
		ignored: whole(parseUnitCount),
		uncategorised: whole(parseUnitCount),
		comments: whole(parseCommentCount),
		overall: z
			.number()
			.int()
			.min(0)
			.max(1)
			.transform((n) => n === 1),
		text: text((t) => (t === '' ? err(t) : ok(textForAgent(t))))
	})
	.refine(({ counted, reviewed, uncategorised }) => reviewed <= counted && uncategorised <= counted)
	.transform(
		({
			number,
			version,
			submittedAt,
			counted,
			reviewed,
			ignored,
			uncategorised,
			comments,
			overall,
			text
		}) =>
			({
				number,
				version,
				submittedAt,
				progress: { counted, reviewed, ignored, uncategorised },
				comments,
				overall,
				text
			}) satisfies Omit<FinishedReview, 'posted'>
	);

/** A review read with where it was posted, from `review_deliveries`. */
function withDeliveries(
	q: Queries,
	report: ReportId,
	reviews: readonly Omit<FinishedReview, 'posted'>[]
): Result<readonly FinishedReview[], StoredRowInvalid> {
	if (reviews.length === 0) return ok([]);
	return map(deliveriesOf(q, report), (posted) =>
		reviews.map((r) => ({ ...r, posted: posted.get(r.number) }))
	);
}

const COLUMNS = `v.number, r.number AS version, v.submitted_at AS submittedAt, v.counted,
	v.reviewed, v.ignored, v.uncategorised, v.export_text AS text, v.summary <> '' AS overall,
	(SELECT count(*) FROM review_comments c
	 WHERE c.report_id = v.report_id AND c.review_number = v.number) AS comments`;

/** Every review of the report, oldest first. */
export function reviewsOf(
	q: Queries,
	report: ReportId
): Result<readonly FinishedReview[], StoredRowInvalid> {
	return andThen(
		parseRows(
			'reviews',
			row,
			q.all(
				`SELECT ${COLUMNS} FROM reviews v JOIN revisions r ON r.id = v.revision_id
				 WHERE v.report_id = ? ORDER BY v.number`,
				report
			)
		),
		(reviews) => withDeliveries(q, report, reviews)
	);
}

/** One review of the report, or its latest when `number` is undefined; undefined when there is none. */
export function reviewOf(
	q: Queries,
	report: ReportId,
	number: ReviewNumber | undefined
): Result<FinishedReview | undefined, StoredRowInvalid> {
	const found =
		number === undefined
			? q.get(
					`SELECT ${COLUMNS} FROM reviews v JOIN revisions r ON r.id = v.revision_id
					 WHERE v.report_id = ? ORDER BY v.number DESC LIMIT 1`,
					report
				)
			: q.get(
					`SELECT ${COLUMNS} FROM reviews v JOIN revisions r ON r.id = v.revision_id
					 WHERE v.report_id = ? AND v.number = ?`,
					report,
					number
				);
	if (found === undefined) return ok(undefined);
	return andThen(parseRow('reviews', row, found), (review) =>
		map(withDeliveries(q, report, [review]), (reviews) => reviews[0])
	);
}

const latest = z.object({ number: nullable(whole(parseReviewNumber)) });

/** The number of the report's latest review; undefined when it has none. */
export function latestReviewNumber(
	q: Queries,
	report: ReportId
): Result<ReviewNumber | undefined, StoredRowInvalid> {
	const found = q.get('SELECT max(number) AS number FROM reviews WHERE report_id = ?', report);
	return map(parseRow('reviews', latest, found ?? { number: null }), (r) => r.number);
}

/** Records a finished review. Its comments and marks are written beside it, in the same transaction. */
export function insertReview(
	q: Queries,
	report: ReportId,
	number: ReviewNumber,
	revision: RevisionId,
	submittedAt: Timestamp,
	progress: UnitProgress,
	exported: TextForAgent,
	overall: string
): void {
	q.run(
		`INSERT INTO reviews (report_id, number, revision_id, submitted_at, export_text,
			counted, reviewed, ignored, uncategorised, summary)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		report,
		number,
		revision,
		submittedAt,
		exported,
		progress.counted,
		progress.reviewed,
		progress.ignored,
		progress.uncategorised,
		overall
	);
}
