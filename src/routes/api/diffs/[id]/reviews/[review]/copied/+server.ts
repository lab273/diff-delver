import type { HandoverNoted } from '#lib/api/schemas.ts';
import { PRIVATE } from '#lib/server/api/comments.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import { reviewNumberIn, reviewsRefused } from '#lib/server/api/reviews.ts';
import type { RequestHandler } from './$types';

/** Notes that a page copied a finished review, for its delivery log (DESIGN 6.3). */
export const POST: RequestHandler = ({ locals, params, request }) => {
	const refused = reviewsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const number = reviewNumberIn(params.review);
	if (!number.ok) return number.error;
	const noted = locals.daemon.service.noteHandover(id.value, number.value, 'clipboard');
	if (!noted.ok) return serviceFailure(noted.error);
	const body: HandoverNoted = { noted: true };
	return Response.json(body, { headers: PRIVATE });
};
