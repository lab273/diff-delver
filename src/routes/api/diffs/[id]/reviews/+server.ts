import { FinishReviewSchema, type FinishedReviewsView } from '#lib/api/schemas.ts';
import { PRIVATE } from '#lib/server/api/comments.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody } from '#lib/server/api/request.ts';
import { justFinishedView, reviewsRefused, reviewView } from '#lib/server/api/reviews.ts';
import type { RequestHandler } from './$types';

/** The Delve's finished reviews, oldest first, each with the text that was handed over. */
export const GET: RequestHandler = ({ locals, params, request }) => {
	const refused = reviewsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const reviews = locals.daemon.service.reviews(id.value);
	if (!reviews.ok) return serviceFailure(reviews.error);
	const body: FinishedReviewsView = {
		now: locals.daemon.clock.now(),
		reviews: reviews.value.map(reviewView)
	};
	return Response.json(body, { headers: PRIVATE });
};

/**
 * Finishes the draft the page showed as the Delve's next review, on the version
 * it shows, and for a pull request's Delve, when asked, posts it to GitHub.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const refused = reviewsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const parsed = await readBody(request, FinishReviewSchema);
	if (!parsed.ok) return parsed.error;
	const shown = { comments: parsed.value.comments, overall: parsed.value.overall };
	const { github } = parsed.value;
	const finished =
		github === undefined
			? await locals.daemon.service.finishReview(id.value, parsed.value.version, shown)
			: await locals.daemon.service.postReview(id.value, parsed.value.version, shown, github);
	return finished.ok
		? Response.json(justFinishedView(finished.value), { status: 201, headers: PRIVATE })
		: serviceFailure(finished.error);
};
