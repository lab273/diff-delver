import { ReviewPreviewQuerySchema, type ReviewPreviewView } from '#lib/api/schemas.ts';
import { PRIVATE } from '#lib/server/api/comments.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery } from '#lib/server/api/request.ts';
import { reviewsRefused } from '#lib/server/api/reviews.ts';
import type { RequestHandler } from './$types';

/** What finishing the draft now would hand over, for a page that shows `version`. */
export const GET: RequestHandler = async ({ locals, params, request, url }) => {
	const refused = reviewsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, ReviewPreviewQuerySchema);
	if (!query.ok) return query.error;
	const preview = await locals.daemon.service.previewReview(id.value, query.value.version);
	if (!preview.ok) return serviceFailure(preview.error);
	const body: ReviewPreviewView = {
		number: preview.value.number,
		text: preview.value.text,
		comments: preview.value.comments.map((c) => ({ id: c.id, edits: c.edits })),
		overall: preview.value.overall.edits,
		resolutions: [...preview.value.resolutions],
		github:
			preview.value.github === undefined
				? null
				: { body: preview.value.github.body, onLines: [...preview.value.github.onLines] }
	};
	return Response.json(body, { headers: PRIVATE });
};
