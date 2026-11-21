import { z } from 'zod';
import { parseLineNumber } from '#lib/core/line-number.tiny.ts';
import { repoPathBytes } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { RevisionId } from '#lib/core/revision-id.tiny.ts';
import { parseRevisionNumber, type RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import {
	MAX_COMMENT_LENGTH,
	type CommentAnchor,
	type DraftComment
} from '#lib/core/review/draft-comment.ts';
import { parseRow, parseRows, repoPath, whole } from '../columns.ts';
import type { Queries } from '../database.ts';

const row = z
	.object({
		id: z.number().int().positive(),
		version: whole(parseRevisionNumber),
		path: repoPath,
		side: z.enum(['old', 'new']),
		first: whole(parseLineNumber),
		last: whole(parseLineNumber),
		body: z.string().min(1).max(MAX_COMMENT_LENGTH)
	})
	.refine(({ first, last, body }) => last >= first && body.trim() !== '')
	.transform(({ id, version, path, side, first, last, body }): DraftComment => ({
		id,
		version,
		anchor: { path, side, first, last },
		body
	}));

/** All comments in the Delve's draft, in the order they were saved. */
export function draftCommentsOf(q: Queries, report: ReportId) {
	return parseRows(
		'draft_comments',
		row,
		q.all(
			`SELECT c.id, r.number AS version, c.path, c.side, c.first_line AS first,
		        c.last_line AS last, c.body
		 FROM revisions r JOIN draft_comments c ON r.id = c.revision_id
		 WHERE r.report_id = ? ORDER BY c.id`,
			report
		)
	);
}

export function insertDraftComment(
	q: Queries,
	revision: RevisionId,
	version: RevisionNumber,
	anchor: CommentAnchor,
	body: string
) {
	const saved = q.get(
		`INSERT INTO draft_comments (revision_id, path, side, first_line, last_line, body)
		 VALUES (?, ?, ?, ?, ?, ?)
		 RETURNING id, ? AS version, path, side, first_line AS first, last_line AS last, body`,
		revision,
		repoPathBytes(anchor.path),
		anchor.side,
		anchor.first,
		anchor.last,
		body,
		version
	);
	return parseRow('draft_comments', row, saved ?? {});
}
