/**
 * The `review_comments` table: the comments of a finished review (DESIGN
 * 6.3), frozen in the order they were written, each with its lines in the
 * revision it was written on, the reviewer's words and the code it is on as
 * that revision's snapshot held it. The only code that sees its rows.
 */
import { z } from 'zod';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { parseLineText } from '#lib/core/line-text.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import { MAX_COMMENT_LENGTH } from '#lib/core/review/draft-comment.ts';
import { MAX_QUOTED_LINES, type SubmittedComment } from '#lib/core/review/review-export.ts';
import { parseReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import type { DraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { parseRows, repoPath, text, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

/** The quoted lines, stored as a JSON array of strings. */
const quoted = z
	.string()
	.transform((value, context) => {
		try {
			const lines: unknown = JSON.parse(value);
			return lines;
		} catch {
			context.addIssue({ code: 'custom', message: 'is not JSON' });
			return z.NEVER;
		}
	})
	.pipe(z.array(text(parseLineText)).max(MAX_QUOTED_LINES));

const row = z
	.object({
		version: whole(parseRevisionNumber),
		path: repoPath,
		side: z.enum(['old', 'new']),
		first: whole(parseLineNumber),
		last: whole(parseLineNumber),
		body: z.string().min(1).max(MAX_COMMENT_LENGTH),
		quoted
	})
	.refine(({ first, last }) => last >= first)
	.transform(({ version, path, side, first, last, body, quoted }): SubmittedComment => ({
		anchor: { path, side, first, last },
		version,
		body,
		quoted
	}));

/** The comments of a finished review, in the order they were written. */
export function reviewCommentsOf(
	q: Queries,
	report: ReportId,
	number: ReviewNumber
): Result<readonly SubmittedComment[], StoredRowInvalid> {
	return parseRows(
		'review_comments',
		row,
		q.all(
			`SELECT r.number AS version, c.path, c.side, c.first_line AS first, c.last_line AS last,
				c.body, c.quoted
			 FROM review_comments c JOIN revisions r ON r.id = c.revision_id
			 WHERE c.report_id = ? AND c.review_number = ? ORDER BY c.position`,
			report,
			number
		)
	);
}

const holdingRow = z.object({ number: whole(parseReviewNumber) });

/**
 * Which finished review holds the draft comment `draft`, or undefined when
 * none does: a draft comment's id is never given to another, so one that is
 * no longer in the draft was either deleted or finished.
 */
export function reviewHolding(
	q: Queries,
	report: ReportId,
	draft: DraftCommentId
): Result<ReviewNumber | undefined, StoredRowInvalid> {
	return andThen(
		parseRows(
			'review_comments',
			holdingRow,
			q.all(
				`SELECT review_number AS number FROM review_comments
				 WHERE report_id = ? AND draft_comment_id = ?`,
				report,
				draft
			)
		),
		(rows) => ok(rows[0]?.number)
	);
}

/** One comment of a finished review, as it is frozen: the draft comment it was, on the revision it was written on, when. */
export interface ReviewCommentRow {
	readonly draft: DraftCommentId;
	readonly revision: RevisionId;
	readonly comment: SubmittedComment;
	readonly writtenAt: Timestamp;
}

/** Writes a finished review's comments, numbered from 1 in the order given. */
export function insertReviewComments(
	q: Queries,
	report: ReportId,
	number: ReviewNumber,
	comments: readonly ReviewCommentRow[]
): void {
	comments.forEach(({ draft, revision, comment, writtenAt }, i) => {
		q.run(
			`INSERT INTO review_comments (report_id, review_number, position, draft_comment_id,
				revision_id, path, side, first_line, last_line, body, written_at, quoted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			report,
			number,
			i + 1,
			draft,
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
}
