/**
 * The `threads` table, with `thread_places`, `draft_resolutions`,
 * `review_resolutions` and the starting and replying rows of
 * `review_comments` (DESIGN 6.3): each comment or flag of a finished review
 * starts a thread of the Delve, followed to its lines in later versions,
 * replied to by later reviews' comments and resolved or opened again by them.
 * The only code that sees the rows of these tables.
 */
import { z } from 'zod';
import type { LineText } from '#lib/core/line-text.tiny.ts';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import { andThen, ok, type Result } from '#lib/core/result.ts';
import type { CommentAnchor } from '#lib/core/review/draft-comment.ts';
import type { ThreadMessage, ThreadPlace, ThreadResolution } from '#lib/core/review/threads.ts';
import { parseReviewNumber, type ReviewNumber } from '#lib/core/review-number.tiny.ts';
import { parseRevisionId, type RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { parseThreadId, type ThreadId } from '#lib/core/thread-id.tiny.ts';
import { nullable, parseRows, repoPath, text, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';
import { quoted } from './review-comments.ts';

const flag = z
	.number()
	.int()
	.min(0)
	.max(1)
	.transform((n) => n === 1);

/** A thread resolved or opened again, in the draft or a review being posted: which, on which version. */
export interface ResolutionRow {
	readonly thread: ThreadId;
	readonly revision: RevisionId;
	readonly resolved: boolean;
}

export const resolutionRow = z.object({
	thread: whole(parseThreadId),
	revision: text(parseRevisionId),
	resolved: flag
});

/** A thread as stored: its messages, oldest first, where it has been followed, and what reviews did to it. */
export interface StoredThread {
	readonly id: ThreadId;
	readonly messages: readonly ThreadMessage[];
	/** The code its first message was on, as its review quoted it. */
	readonly quoted: readonly LineText[];
	readonly resolutions: readonly ThreadResolution[];
	/** Each version it has been followed to, oldest first. */
	readonly places: readonly (ThreadPlace & { readonly revision: RevisionId })[];
}

const messageRow = z
	.object({
		thread: whole(parseThreadId),
		review: whole(parseReviewNumber),
		kind: z.enum(['comment', 'flag']),
		version: whole(parseRevisionNumber),
		path: repoPath,
		side: z.enum(['old', 'new']),
		first: whole(parseLineNumber),
		last: whole(parseLineNumber),
		body: z.string(),
		writtenAt: timestamp,
		quoted
	})
	.refine(({ first, last }) => last >= first);

const placeRow = z
	.object({
		thread: whole(parseThreadId),
		revision: text(parseRevisionId),
		version: whole(parseRevisionNumber),
		path: nullable(repoPath),
		side: nullable(z.enum(['old', 'new'])),
		first: nullable(whole(parseLineNumber)),
		last: nullable(whole(parseLineNumber)),
		edited: flag
	})
	.transform(({ thread, revision, version, path, side, first, last, edited }) => ({
		thread,
		revision,
		version,
		anchor:
			path === undefined || side === undefined || first === undefined || last === undefined
				? undefined
				: ({ path, side, first, last } satisfies CommentAnchor),
		edited
	}));

const resolvedRow = z.object({
	thread: whole(parseThreadId),
	review: whole(parseReviewNumber),
	version: whole(parseRevisionNumber),
	resolved: flag
});

const MESSAGE_COLUMNS = `c.review_number AS review, c.kind, r.number AS version, c.path, c.side,
	c.first_line AS first, c.last_line AS last, c.body, c.written_at AS writtenAt, c.quoted`;

/** Every thread of the Delve, in the order they were started. */
export function threadsOf(
	q: Queries,
	report: ReportId
): Result<readonly StoredThread[], StoredRowInvalid> {
	const messages = parseRows(
		'review_comments',
		messageRow,
		q.all(
			`SELECT t.id AS thread, 1 AS start, c.position, ${MESSAGE_COLUMNS}
			 FROM threads t
			 JOIN review_comments c ON c.report_id = t.report_id
				AND c.review_number = t.review_number AND c.position = t.position
			 JOIN revisions r ON r.id = c.revision_id
			 WHERE t.report_id = ?
			 UNION ALL
			 SELECT c.reply_to AS thread, 0 AS start, c.position, ${MESSAGE_COLUMNS}
			 FROM review_comments c JOIN revisions r ON r.id = c.revision_id
			 WHERE c.report_id = ? AND c.reply_to IS NOT NULL
			 ORDER BY thread, start DESC, review, position`,
			report,
			report
		)
	);
	if (!messages.ok) return messages;
	return andThen(
		parseRows(
			'thread_places',
			placeRow,
			q.all(
				`SELECT p.thread_id AS thread, p.revision_id AS revision, r.number AS version, p.path,
					p.side, p.first_line AS first, p.last_line AS last, p.edited
				 FROM thread_places p JOIN threads t ON t.id = p.thread_id
				 JOIN revisions r ON r.id = p.revision_id
				 WHERE t.report_id = ? ORDER BY p.thread_id, r.number`,
				report
			)
		),
		(places) =>
			andThen(
				parseRows(
					'review_resolutions',
					resolvedRow,
					q.all(
						`SELECT s.thread_id AS thread, s.review_number AS review, r.number AS version, s.resolved
						 FROM review_resolutions s JOIN revisions r ON r.id = s.revision_id
						 WHERE s.report_id = ? ORDER BY s.thread_id, s.review_number`,
						report
					)
				),
				(resolutions) => {
					const threads = new Map<
						ThreadId,
						{
							messages: ThreadMessage[];
							quoted: readonly LineText[];
							resolutions: ThreadResolution[];
							places: (ThreadPlace & { revision: RevisionId })[];
						}
					>();
					for (const m of messages.value) {
						const found = threads.get(m.thread);
						const message: ThreadMessage = {
							review: m.review,
							kind: m.kind,
							version: m.version,
							anchor: { path: m.path, side: m.side, first: m.first, last: m.last },
							body: m.body,
							writtenAt: m.writtenAt
						};
						if (found === undefined) {
							threads.set(m.thread, {
								messages: [message],
								quoted: m.quoted,
								resolutions: [],
								places: []
							});
						} else found.messages.push(message);
					}
					for (const p of places) {
						threads.get(p.thread)?.places.push({
							revision: p.revision,
							version: p.version,
							anchor: p.anchor,
							edited: p.edited
						});
					}
					for (const r of resolutions) {
						threads.get(r.thread)?.resolutions.push({
							review: r.review,
							resolved: r.resolved,
							version: r.version
						});
					}
					return ok([...threads].map(([id, t]) => ({ id, ...t })));
				}
			)
	);
}

/**
 * Starts a thread for each comment and flag of finished review `number` that
 * is not a reply, on its lines in its own version, in the transaction that
 * records the review.
 */
export function startThreads(q: Queries, report: ReportId, number: ReviewNumber): void {
	q.run(
		`INSERT INTO threads (report_id, review_number, position)
		 SELECT report_id, review_number, position FROM review_comments
		 WHERE report_id = ? AND review_number = ? AND reply_to IS NULL ORDER BY position`,
		report,
		number
	);
	q.run(
		`INSERT INTO thread_places (thread_id, revision_id, path, side, first_line, last_line, edited)
		 SELECT t.id, c.revision_id, c.path, c.side, c.first_line, c.last_line, 0
		 FROM threads t JOIN review_comments c ON c.report_id = t.report_id
			AND c.review_number = t.review_number AND c.position = t.position
		 WHERE t.report_id = ? AND t.review_number = ?`,
		report,
		number
	);
}

/** Records where a thread's lines are in a version, or that they are gone; once for each version. */
export function insertThreadPlace(
	q: Queries,
	thread: ThreadId,
	revision: RevisionId,
	anchor: CommentAnchor | undefined,
	edited: boolean
): void {
	q.run(
		`INSERT OR IGNORE INTO thread_places (thread_id, revision_id, path, side, first_line,
			last_line, edited)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		thread,
		revision,
		anchor === undefined ? null : repoPathBytes(anchor.path),
		anchor?.side ?? null,
		anchor?.first ?? null,
		anchor?.last ?? null,
		edited ? 1 : 0
	);
}

/** The threads the Delve's draft resolves or opens again. */
export function draftResolutionsOf(
	q: Queries,
	report: ReportId
): Result<readonly ResolutionRow[], StoredRowInvalid> {
	return parseRows(
		'draft_resolutions',
		resolutionRow,
		q.all(
			`SELECT d.thread_id AS thread, d.revision_id AS revision, d.resolved
			 FROM draft_resolutions d JOIN threads t ON t.id = d.thread_id
			 WHERE t.report_id = ? ORDER BY d.thread_id`,
			report
		)
	);
}

/** Resolves a thread in the draft, or opens it again, in place of what the draft did to it before. */
export function setDraftResolution(
	q: Queries,
	thread: ThreadId,
	revision: RevisionId,
	resolved: boolean
): void {
	q.run(
		`INSERT INTO draft_resolutions (thread_id, revision_id, resolved) VALUES (?, ?, ?)
		 ON CONFLICT (thread_id) DO UPDATE SET revision_id = excluded.revision_id, resolved = excluded.resolved`,
		thread,
		revision,
		resolved ? 1 : 0
	);
}

/** Takes back what the draft did to a thread. */
export function deleteDraftResolution(q: Queries, thread: ThreadId): void {
	q.run('DELETE FROM draft_resolutions WHERE thread_id = ?', thread);
}

/** Records what finished review `number` resolved or opened again. */
export function insertReviewResolutions(
	q: Queries,
	report: ReportId,
	number: ReviewNumber,
	resolutions: readonly ResolutionRow[]
): void {
	for (const r of resolutions) {
		q.run(
			`INSERT INTO review_resolutions (report_id, review_number, thread_id, revision_id, resolved)
			 VALUES (?, ?, ?, ?, ?)`,
			report,
			number,
			r.thread,
			r.revision,
			r.resolved ? 1 : 0
		);
	}
}
