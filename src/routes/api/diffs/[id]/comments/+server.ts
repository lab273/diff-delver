import { AddDraftCommentSchema, type DraftCommentView } from '#lib/api/schemas.ts';
import { escapedRepoPath, resolveEscapedPath } from '#lib/core/path-bytes.ts';
import type { DraftComment } from '#lib/core/review/draft-comment.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

function commentView(comment: DraftComment): DraftCommentView {
	return { ...comment, anchor: { ...comment.anchor, path: escapedRepoPath(comment.anchor.path) } };
}

export const GET: RequestHandler = ({ locals, params }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const comments = locals.daemon.service.draftComments(id.value);
	return comments.ok
		? Response.json(comments.value.map(commentView))
		: serviceFailure(comments.error);
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const parsed = await readBody(request, AddDraftCommentSchema);
	if (!parsed.ok) return parsed.error;
	const { version, anchor, body } = parsed.value;
	const path = resolveEscapedPath(anchor.path);
	if (path === undefined) return unknownPath();
	const saved = await locals.daemon.service.addDraftComment(
		id.value,
		version,
		{ ...anchor, path },
		body
	);
	return saved.ok
		? Response.json(commentView(saved.value), { status: 201 })
		: serviceFailure(saved.error);
};
