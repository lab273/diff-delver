/**
 * The `review_deliveries` table: the delivery log of each finished review
 * (DESIGN 6.3), one row for each way it was handed over. Posted to GitHub,
 * as one review of its pull request: how it was posted, its address there,
 * how many of its comments went in its text, and when, written in the
 * transaction that records the review and never changed. Copied from the
 * page, and read by an agent with get_review: when first, when last and how
 * many times. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseCommentCount } from '#lib/core/comment-count.tiny.ts';
import type { GitHubReviewId } from '#lib/core/github/github-review-id.tiny.ts';
import { parseGitHubReviewAddress } from '#lib/core/github/github-review-address.tiny.ts';
import { parseHandoverCount } from '#lib/core/handover-count.tiny.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import type { GitHubDelivery, Handover } from '#lib/core/review/review-export.ts';
import { parseReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseRows, text, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const github = z.object({
	number: whole(parseReviewNumber),
	postedAs: z.enum(['comment', 'approve', 'request-changes', 'draft']),
	address: text(parseGitHubReviewAddress),
	inText: whole(parseCommentCount),
	at: timestamp
});

const handover = z
	.object({
		number: whole(parseReviewNumber),
		destination: z.enum(['clipboard', 'agent']),
		first: timestamp,
		last: timestamp,
		times: whole(parseHandoverCount)
	})
	.refine(({ first, last }) => last >= first);

/** A finished review's delivery log, as `review_deliveries` keeps it. */
export interface Deliveries {
	readonly posted: GitHubDelivery | undefined;
	readonly copied: Handover | undefined;
	readonly read: Handover | undefined;
}

/** The delivery log of each of the report's reviews, by review number. */
export function deliveriesOf(
	q: Queries,
	report: ReportId
): Result<ReadonlyMap<ReviewNumber, Deliveries>, StoredRowInvalid> {
	return andThen(
		parseRows(
			'review_deliveries',
			github,
			q.all(
				`SELECT review_number AS number, posted_as AS postedAs, address, in_text AS inText,
					delivered_at AS at
				 FROM review_deliveries WHERE report_id = ? AND destination = 'github'`,
				report
			)
		),
		(posts) =>
			andThen(
				parseRows(
					'review_deliveries',
					handover,
					q.all(
						`SELECT review_number AS number, destination, delivered_at AS first, last_at AS last,
							times
						 FROM review_deliveries WHERE report_id = ? AND destination <> 'github'`,
						report
					)
				),
				(handovers) => {
					const log = new Map<ReviewNumber, Deliveries>();
					const of = (n: ReviewNumber): Deliveries =>
						log.get(n) ?? { posted: undefined, copied: undefined, read: undefined };
					for (const p of posts) {
						log.set(p.number, {
							...of(p.number),
							posted: { postedAs: p.postedAs, address: p.address, inText: p.inText, at: p.at }
						});
					}
					for (const h of handovers) {
						const kept: Handover = { times: h.times, first: h.first, last: h.last };
						log.set(
							h.number,
							h.destination === 'clipboard'
								? { ...of(h.number), copied: kept }
								: { ...of(h.number), read: kept }
						);
					}
					return ok(log);
				}
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
			github_review_id, address, in_text, delivered_at, last_at, times)
		 VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?, 1)`,
		report,
		number,
		delivery.postedAs,
		review,
		delivery.address,
		delivery.inText,
		delivery.at,
		delivery.at
	);
}

/**
 * Records one more handing over of a finished review: copied from the page,
 * or read by an agent. Nothing for a review the report does not have.
 */
export function noteHandover(
	q: Queries,
	report: ReportId,
	number: ReviewNumber,
	destination: 'clipboard' | 'agent',
	at: Timestamp
): void {
	q.run(
		`INSERT INTO review_deliveries (report_id, review_number, destination, delivered_at, last_at, times)
		 SELECT report_id, number, ?, ?, ?, 1 FROM reviews WHERE report_id = ? AND number = ?
		 ON CONFLICT (report_id, review_number, destination)
		 DO UPDATE SET last_at = max(last_at, excluded.last_at), times = times + 1`,
		destination,
		at,
		at,
		report,
		number
	);
}
