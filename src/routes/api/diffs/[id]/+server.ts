import { PageQuerySchema, type DeletedResponse, type DiffPage } from '#lib/api/schemas.ts';
import { pageView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery } from '#lib/server/api/request.ts';
import { canReview, reviewSessionRequired } from '#lib/server/api/review-session.ts';
import type { RequestHandler } from './$types';

/**
 * One diff, as its page shows it: everything but the code, which comes a part
 * at a time. Its newest version, or the one asked for.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, PageQuerySchema);
	if (!query.ok) return query.error;
	const { service, clock } = locals.daemon;
	const { version, view, since } = query.value;
	const prefix = `${view}:`;
	if (version !== undefined && since?.startsWith(prefix)) {
		const unchanged = service.frameUnchanged(id.value, version, since.slice(prefix.length));
		if (!unchanged.ok) return serviceFailure(unchanged.error);
		if (unchanged.value) return Response.json(null);
	}
	const loaded = await service.load(id.value, version);
	if (!loaded.ok) return serviceFailure(loaded.error);
	const body: DiffPage = pageView(loaded.value, clock.now(), view);
	return Response.json(body);
};

/** Deletes a diff, with what diff delver saved of it. */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	if (!canReview(locals.daemon, request))
		return reviewSessionRequired('delete a Delve', 'deleting');
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const deleted = await locals.daemon.service.deleteReport(id.value);
	if (!deleted.ok) return serviceFailure(deleted.error);
	const body: DeletedResponse = { problem: deleted.value.storeProblem ?? null };
	return Response.json(body);
};
