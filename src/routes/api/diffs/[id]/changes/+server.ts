import type { ChangeCheckResponse } from '#lib/api/schemas.ts';
import { parseRevisionNumber } from '#lib/core/revision-number.tiny.ts';
import { badRequest, changeView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * Whether the diff has a newer version than `seen`, the one the page shows, and
 * otherwise whether its source has moved on. Reads the repository, never writes it.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const seenText = url.searchParams.get('seen');
	const seen = seenText === null ? undefined : parseRevisionNumber(Number(seenText));
	if (seen !== undefined && !seen.ok) return badRequest('the version it shows is not a number');
	const checked = await locals.daemon.service.checkForChanges(id.value, seen?.value);
	if (!checked.ok) return serviceFailure(checked.error);
	const body: ChangeCheckResponse = changeView(checked.value);
	return Response.json(body);
};
