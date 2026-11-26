import { AddDraftCommentSchema, type DraftCommentsView } from '#lib/api/schemas.ts';
import { resolveEscapedPath } from '#lib/core/path-bytes.ts';
import {
	PRIVATE,
	commentView,
	draftsRefused,
	overallReviewView
} from '#lib/server/api/comments.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** The reviewer's whole draft, its comments and its overall review, with the daemon's time, for a browser that may read it. */
export const GET: RequestHandler = ({ locals, params, request }) => {
	const refused = draftsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const comments = locals.daemon.service.draftComments(id.value);
	if (!comments.ok) return serviceFailure(comments.error);
	const overall = locals.daemon.service.overallReview(id.value);
	if (!overall.ok) return serviceFailure(overall.error);
	const body: DraftCommentsView = {
		now: locals.daemon.clock.now(),
		comments: comments.value.map(commentView),
		overall: overallReviewView(overall.value)
	};
	return Response.json(body, { headers: PRIVATE });
};

/** Saves a comment, or a flag, on lines of the version the page shows. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const refused = draftsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const parsed = await readBody(request, AddDraftCommentSchema);
	if (!parsed.ok) return parsed.error;
	const { kind, version, anchor, body } = parsed.value;
	const path = resolveEscapedPath(anchor.path);
	if (path === undefined) return unknownPath();
	const saved = await locals.daemon.service.addDraftComment(
		id.value,
		version,
		{ ...anchor, path },
		body,
		kind
	);
	return saved.ok
		? Response.json(commentView(saved.value), { status: 201, headers: PRIVATE })
		: serviceFailure(saved.error);
};
