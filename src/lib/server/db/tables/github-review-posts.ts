/**
 * The `github_review_posts` table, with `github_review_post_comments` and
 * `github_review_post_marks`: a Delve's draft being posted to GitHub, as
 * exactly what was sent, written before the review is sent and removed once
 * it is recorded or GitHub refused it. A note that is left means the review
 * may be on GitHub already: the next finish looks there first, so it is
 * never posted twice, and records what the note holds, which is what GitHub
 * was given, not the draft as it is by then. The only code that sees their
 * rows.
 */
import { z } from 'zod';
import { parseCommentCount, type CommentCount } from '#lib/core/comment-count.tiny.ts';
import { parseDraftCommentId, type DraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import { parseEditCount, type EditCount } from '#lib/core/edit-count.tiny.ts';
import type { PostedAs } from '#lib/core/github/github-review.ts';
import { parseReviewMark, type ReviewMark } from '#lib/core/github/review-mark.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { UnitProgress } from '#lib/core/reports/report.ts';
import { andThen, err, map, ok, type Result } from '#lib/core/result.ts';
import { parseReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import { parseRevisionId, type RevisionId } from '#lib/core/revision-id.tiny.ts';
import { textForAgent, type TextForAgent } from '#lib/core/text-for-agent.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseUnitCount } from '#lib/core/unit-count.tiny.ts';
import { parseRow, parseRows, text, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import type { ReviewCommentRow } from './review-comments.ts';

/** A comment of the draft as it was sent: which, and how many times its words had been changed. */
export interface SentComment {
	readonly draft: DraftCommentId;
	readonly edits: EditCount;
}

/** A review being posted to GitHub, as it was sent. */
export interface ReviewPostNote {
	readonly number: ReviewNumber;
	/** The secret part of the mark its text ends with, made for this post. */
	readonly mark: ReviewMark;
	/** When it was first sent. */
	readonly startedAt: Timestamp;
	readonly revision: RevisionId;
	readonly text: TextForAgent;
	readonly progress: UnitProgress;
	/** The overall review sent, exactly as typed; '' for none. */
	readonly overall: string;
	/** How many times the overall review's words had been changed when it was sent. */
	readonly overallEdits: EditCount;
	/** How it was asked to be posted. */
	readonly postedAs: PostedAs;
	/** Whether every comment went in its text, as when it was sent again after GitHub refused their lines. */
	readonly allInText: boolean;
	/** How many comments went in its text. */
	readonly inText: CommentCount;
	readonly comments: readonly SentComment[];
}

/** What is noted of a review about to be sent: the note, with its comments as the review will keep them. */
export interface ReviewToNote extends Omit<ReviewPostNote, 'comments' | 'startedAt'> {
	readonly comments: readonly (ReviewCommentRow & { readonly edits: EditCount })[];
}

const row = z
	.object({
		number: whole(parseReviewNumber),
		mark: text(parseReviewMark),
		startedAt: timestamp,
		revision: text(parseRevisionId),
		text: text((t) => (t === '' ? err(t) : ok(textForAgent(t)))),
		counted: whole(parseUnitCount),
		reviewed: whole(parseUnitCount),
		ignored: whole(parseUnitCount),
		uncategorised: whole(parseUnitCount),
		overall: z.string(),
		overallEdits: whole(parseEditCount),
		postedAs: z.enum(['comment', 'approve', 'request-changes', 'draft']),
		allInText: z
			.number()
			.int()
			.min(0)
			.max(1)
			.transform((n) => n === 1),
		inText: whole(parseCommentCount)
	})
	.transform(
		({ counted, reviewed, ignored, uncategorised, ...rest }): Omit<ReviewPostNote, 'comments'> => ({
			...rest,
			progress: { counted, reviewed, ignored, uncategorised }
		})
	);

const commentRow = z.object({
	draft: whole(parseDraftCommentId),
	edits: whole(parseEditCount)
});

/** The review of the Delve's draft that may be on GitHub already, as it was sent; undefined when none is. */
export function reviewBeingPosted(
	q: Queries,
	report: ReportId
): Result<ReviewPostNote | undefined, StoredRowInvalid> {
	const found = q.get(
		`SELECT review_number AS number, mark, started_at AS startedAt, revision_id AS revision, export_text AS text, counted,
			reviewed, ignored, uncategorised, summary AS overall, summary_edits AS overallEdits,
			posted_as AS postedAs, all_in_text AS allInText, in_text AS inText
		 FROM github_review_posts WHERE report_id = ?`,
		report
	);
	if (found === undefined) return ok(undefined);
	return andThen(parseRow('github_review_posts', row, found), (note) =>
		map(
			parseRows(
				'github_review_post_comments',
				commentRow,
				q.all(
					`SELECT draft_comment_id AS draft, edits FROM github_review_post_comments
					 WHERE report_id = ? ORDER BY position`,
					report
				)
			),
			(comments): ReviewPostNote => ({ ...note, comments })
		)
	);
}

/**
 * Notes that review `review.number` of the Delve is about to be sent to
 * GitHub, as it is sent, with the reviewed marks its revision holds now,
 * in place of any note left before.
 */
export function notePosting(
	q: Queries,
	report: ReportId,
	review: ReviewToNote,
	now: Timestamp
): void {
	forgetPosting(q, report);
	q.run(
		`INSERT INTO github_review_posts (report_id, review_number, mark, started_at, revision_id,
			export_text, counted, reviewed, ignored, uncategorised, summary, summary_edits,
			posted_as, all_in_text, in_text)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		report,
		review.number,
		review.mark,
		now,
		review.revision,
		review.text,
		review.progress.counted,
		review.progress.reviewed,
		review.progress.ignored,
		review.progress.uncategorised,
		review.overall,
		review.overallEdits,
		review.postedAs,
		review.allInText ? 1 : 0,
		review.inText
	);
	review.comments.forEach(({ draft, edits, revision, comment, writtenAt }, i) => {
		q.run(
			`INSERT INTO github_review_post_comments (report_id, position, draft_comment_id, edits,
				revision_id, path, side, first_line, last_line, body, written_at, quoted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			report,
			i + 1,
			draft,
			edits,
			revision,
			repoPathBytes(comment.anchor.path),
			comment.anchor.side,
			comment.anchor.first,
			comment.anchor.last,
			comment.body,
			writtenAt,
			JSON.stringify(comment.quoted)
		);
	});
	q.run(
		`INSERT INTO github_review_post_marks (report_id, path, side, first_line, last_line)
		 SELECT ?, path, side, first_line, last_line FROM reviewed_marks WHERE revision_id = ?`,
		report,
		review.revision
	);
}

/** Notes that the review is sent again with every comment in its text, `inText` of them. */
export function noteAllInText(q: Queries, report: ReportId, inText: CommentCount): void {
	q.run(
		'UPDATE github_review_posts SET all_in_text = 1, in_text = ? WHERE report_id = ?',
		inText,
		report
	);
}

/**
 * Writes the noted review's comments and reviewed marks as the finished
 * review's (`review_comments`, `review_marks`), as they were sent, in the
 * transaction that records the review, whose row must be written first.
 */
export function copyNotedReview(q: Queries, report: ReportId, number: ReviewNumber): void {
	q.run(
		`INSERT INTO review_comments (report_id, review_number, position, draft_comment_id,
			revision_id, path, side, first_line, last_line, body, written_at, quoted)
		 SELECT report_id, ?, position, draft_comment_id, revision_id, path, side, first_line,
			last_line, body, written_at, quoted
		 FROM github_review_post_comments WHERE report_id = ? ORDER BY position`,
		number,
		report
	);
	q.run(
		`INSERT INTO review_marks (report_id, review_number, path, side, first_line, last_line)
		 SELECT report_id, ?, path, side, first_line, last_line
		 FROM github_review_post_marks WHERE report_id = ?`,
		number,
		report
	);
}

/** Forgets the Delve's review being posted: it was recorded, or GitHub refused it. */
export function forgetPosting(q: Queries, report: ReportId): void {
	q.run('DELETE FROM github_review_posts WHERE report_id = ?', report);
}
