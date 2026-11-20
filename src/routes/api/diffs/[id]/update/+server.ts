import type { UpdateResponse } from '#lib/api/schemas.ts';
import { serviceFailure, updateResponseView } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * Brings a diff up to date with its files, keeping what was done to the lines
 * that did not change. Reads the repository, never writes it.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const updated = await locals.daemon.service.update(id.value);
	if (!updated.ok) return serviceFailure(updated.error);
	const body: UpdateResponse = updateResponseView(updated.value);
	return Response.json(body);
};
