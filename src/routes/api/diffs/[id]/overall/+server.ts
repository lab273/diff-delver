import { SaveOverallReviewSchema } from '#lib/api/schemas.ts';
import { PRIVATE, overallReviewView } from '#lib/server/api/comments.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody } from '#lib/server/api/request.ts';
import { canReview, reviewSessionRequired } from '#lib/server/api/review-session.ts';
import type { RequestHandler } from './$types';

/**
 * Replaces the words of the draft's overall review, exactly as typed, on the
 * words the page read: when they were changed elsewhere since, nothing
 * changes and the answer says so (409), so the page keeps what was typed.
 * Read with the rest of the draft, from `comments`.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!canReview(locals.daemon, request)) {
		return reviewSessionRequired('read or change your overall review', 'comments');
	}
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const parsed = await readBody(request, SaveOverallReviewSchema);
	if (!parsed.ok) return parsed.error;
	const saved = locals.daemon.service.saveOverallReview(
		id.value,
		parsed.value.edits,
		parsed.value.body
	);
	return saved.ok
		? Response.json(overallReviewView(saved.value), { headers: PRIVATE })
		: serviceFailure(saved.error);
};
