import {
	DeleteDraftCommentSchema,
	DraftCommentIdInAddressSchema,
	EditDraftCommentSchema
} from '#lib/api/schemas.ts';
import type { DraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import { describeReportError } from '#lib/server/reports/index.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { PRIVATE, commentView, draftsRefused } from '#lib/server/api/comments.ts';
import { failure, serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** The comment an address names; one that names none is a comment that is not there. */
function commentId(text: string | undefined): Result<DraftCommentId, Response> {
	const id = DraftCommentIdInAddressSchema.safeParse(text ?? '');
	return id.success
		? ok(id.data)
		: err(failure(404, 'CommentNotFound', describeReportError({ kind: 'CommentNotFound' })));
}

/**
 * Changes a saved comment's words, from a page that shows the Delve's current
 * version and read the words as they are: on an older page, or when the words
 * were changed elsewhere since, nothing changes and the answer says so (409),
 * so the page keeps what was typed.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const refused = draftsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const comment = commentId(params.comment);
	if (!comment.ok) return comment.error;
	const parsed = await readBody(request, EditDraftCommentSchema);
	if (!parsed.ok) return parsed.error;
	const { version, edits, body } = parsed.value;
	const saved = locals.daemon.service.editDraftComment(
		id.value,
		version,
		comment.value,
		edits,
		body
	);
	return saved.ok
		? Response.json(commentView(saved.value), { headers: PRIVATE })
		: serviceFailure(saved.error);
};

/** Deletes a saved comment, under the same rule; answers with what it was. */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	const refused = draftsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const comment = commentId(params.comment);
	if (!comment.ok) return comment.error;
	const parsed = await readBody(request, DeleteDraftCommentSchema);
	if (!parsed.ok) return parsed.error;
	const deleted = locals.daemon.service.deleteDraftComment(
		id.value,
		parsed.value.version,
		comment.value,
		parsed.value.edits
	);
	return deleted.ok
		? Response.json(commentView(deleted.value), { headers: PRIVATE })
		: serviceFailure(deleted.error);
};
