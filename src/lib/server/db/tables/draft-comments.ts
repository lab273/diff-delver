import { z } from 'zod';
import { parseDraftCommentId, type DraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import { parseEditCount } from '#lib/core/edit-count.tiny.ts';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import {
	MAX_COMMENT_LENGTH,
	type CommentAnchor,
	type DraftComment
} from '#lib/core/review/draft-comment.ts';
import { ok, type Result } from '#lib/core/result.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import { nullable, parseRow, parseRows, repoPath, timestamp, whole } from '../columns.ts';
import type { Queries } from '../database.ts';
import type { StoredRowInvalid } from '../database-error.ts';

const row = z
	.object({
		id: whole(parseDraftCommentId),
		version: whole(parseRevisionNumber),
		path: repoPath,
		side: z.enum(['old', 'new']),
		first: whole(parseLineNumber),
		last: whole(parseLineNumber),
		body: z.string().min(1).max(MAX_COMMENT_LENGTH),
		writtenAt: timestamp,
		editedAt: nullable(timestamp),
		edits: whole(parseEditCount)
	})
	.refine(({ first, last, body }) => last >= first && body.trim() !== '')
	.transform(
		({ id, version, path, side, first, last, body, writtenAt, editedAt, edits }): DraftComment => ({
			id,
			version,
			anchor: { path, side, first, last },
			body,
			writtenAt,
			editedAt,
			edits
		})
	);

/** A comment's columns, with its revision's number as its version. */
const COLUMNS = `c.id, r.number AS version, c.path, c.side, c.first_line AS first,
	c.last_line AS last, c.body, c.written_at AS writtenAt, c.edited_at AS editedAt, c.edits`;

/** All comments in the Delve's draft, in the order they were saved. */
export function draftCommentsOf(q: Queries, report: ReportId) {
	return parseRows(
		'draft_comments',
		row,
		q.all(
			`SELECT ${COLUMNS}
			 FROM revisions r JOIN draft_comments c ON r.id = c.revision_id
			 WHERE r.report_id = ? ORDER BY c.id`,
			report
		)
	);
}

/** One comment of the Delve's draft, or undefined when the Delve has none with that id. */
export function draftCommentOf(
	q: Queries,
	report: ReportId,
	id: DraftCommentId
): Result<DraftComment | undefined, StoredRowInvalid> {
	const found = q.get(
		`SELECT ${COLUMNS}
		 FROM revisions r JOIN draft_comments c ON r.id = c.revision_id
		 WHERE r.report_id = ? AND c.id = ?`,
		report,
		id
	);
	return found === undefined ? ok(undefined) : parseRow('draft_comments', row, found);
}

export function insertDraftComment(
	q: Queries,
	revision: RevisionId,
	anchor: CommentAnchor,
	body: string,
	now: Timestamp
): Result<DraftComment, StoredRowInvalid> {
	const saved = q.get(
		`INSERT INTO draft_comments (revision_id, path, side, first_line, last_line, body, written_at, edits)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0)
		 RETURNING id`,
		revision,
		repoPathBytes(anchor.path),
		anchor.side,
		anchor.first,
		anchor.last,
		body,
		now
	);
	// Read back as any comment is read, so what is answered is what was stored.
	const stored = q.get(
		`SELECT ${COLUMNS}
		 FROM revisions r JOIN draft_comments c ON r.id = c.revision_id WHERE c.id = ?`,
		Number(saved?.['id'])
	);
	return parseRow('draft_comments', row, stored ?? {});
}

/** Changes a comment's words, and says when. Its lines stay as they were. */
export function updateDraftComment(
	q: Queries,
	id: DraftCommentId,
	body: string,
	now: Timestamp
): void {
	q.run(
		'UPDATE draft_comments SET body = ?, edited_at = ?, edits = edits + 1 WHERE id = ?',
		body,
		now,
		id
	);
}

export function deleteDraftComment(q: Queries, id: DraftCommentId): void {
	q.run('DELETE FROM draft_comments WHERE id = ?', id);
}
