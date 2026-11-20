import type { DeletedResponse, DiffPage } from '#lib/api/schemas.ts';
import { pageView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** One diff, as its page shows it. */
export const GET: RequestHandler = async ({ locals, params }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const loaded = await locals.daemon.service.load(id.value);
	if (!loaded.ok) return serviceFailure(loaded.error);
	const body: DiffPage = pageView(loaded.value, locals.daemon.clock.now());
	return Response.json(body);
};

/** Deletes a diff, with what diff delver saved of it. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const deleted = await locals.daemon.service.deleteReport(id.value);
	if (!deleted.ok) return serviceFailure(deleted.error);
	const body: DeletedResponse = { problem: deleted.value.storeProblem ?? null };
	return Response.json(body);
};
