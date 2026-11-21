import { AddDraftCommentSchema, type DraftCommentView } from '#lib/api/schemas.ts';
import { escapedRepoPath, resolveEscapedPath } from '#lib/core/path-bytes.ts';
import type { DraftComment } from '#lib/core/review/draft-comment.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { failure, serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

function commentView(comment: DraftComment): DraftCommentView {
	return { ...comment, anchor: { ...comment.anchor, path: escapedRepoPath(comment.anchor.path) } };
}

const privateResponse = { 'cache-control': 'no-store' };

function browserOnly(
	request: Request,
	isBrowserSession: (cookieHeader: string | undefined) => boolean
): Response | undefined {
	// The daemon's gate checks the Origin for changes made with a cookie.
	// Require that path through the gate, even when the caller also has a bearer token.
	if (
		!request.headers.has('authorization') &&
		isBrowserSession(request.headers.get('cookie') ?? undefined)
	)
		return;
	return failure(
		403,
		'BrowserSessionRequired',
		reviewerMessage(
			'To read or save draft comments, open this Delve in your browser from the link diff delver gives you.'
		)
	);
}

export const GET: RequestHandler = ({ locals, params, request }) => {
	const refused = browserOnly(request, locals.daemon.isBrowserSession);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const comments = locals.daemon.service.draftComments(id.value);
	return comments.ok
		? Response.json(comments.value.map(commentView), { headers: privateResponse })
		: serviceFailure(comments.error);
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const refused = browserOnly(request, locals.daemon.isBrowserSession);
	if (refused !== undefined) return refused;
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
		? Response.json(commentView(saved.value), { status: 201, headers: privateResponse })
		: serviceFailure(saved.error);
};
