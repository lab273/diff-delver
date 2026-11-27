import { PRIVATE } from '#lib/server/api/comments.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import { pastReviewView, reviewNumberIn, reviewsRefused } from '#lib/server/api/reviews.ts';
import type { RequestHandler } from './$types';

/**
 * One finished review, read-only (DESIGN 6.4): the text handed over, how it
 * was handed over, and each thing it held against the version it was written
 * on, with where its thread stands today.
 */
export const GET: RequestHandler = ({ locals, params, request }) => {
	const refused = reviewsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const number = reviewNumberIn(params.review);
	if (!number.ok) return number.error;
	const history = locals.daemon.service.history(id.value);
	if (!history.ok) return serviceFailure(history.error);
	const view = pastReviewView(history.value, number.value, locals.daemon.clock.now());
	if (view === undefined) return serviceFailure({ kind: 'ReviewNotFound', number: number.value });
	return Response.json(view, { headers: PRIVATE });
};
