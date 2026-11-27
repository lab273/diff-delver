import { PRIVATE } from '#lib/server/api/comments.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import { historyView, reviewsRefused } from '#lib/server/api/reviews.ts';
import type { RequestHandler } from './$types';

/**
 * The Delve's history (DESIGN 6.4): its versions and finished reviews in the
 * order they happened, each with what it was, in words.
 */
export const GET: RequestHandler = ({ locals, params, request }) => {
	const refused = reviewsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const history = locals.daemon.service.history(id.value);
	if (!history.ok) return serviceFailure(history.error);
	return Response.json(historyView(history.value, locals.daemon.clock.now()), {
		headers: PRIVATE
	});
};
