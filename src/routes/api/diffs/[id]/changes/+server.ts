import type { ChangeCheckResponse } from '#lib/api/schemas.ts';
import { changeView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** Whether the diff's source has moved on since it was opened. Reads the repository, never writes it. */
export const GET: RequestHandler = async ({ locals, params }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const checked = await locals.daemon.service.checkForChanges(id.value);
	if (!checked.ok) return serviceFailure(checked.error);
	const body: ChangeCheckResponse = changeView(checked.value);
	return Response.json(body);
};
