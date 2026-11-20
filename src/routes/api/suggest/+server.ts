import type { SuggestResponse } from '#lib/api/schemas.ts';
import { parseAbsolutePath } from '#lib/core/absolute-path.tiny.ts';
import { badRequest, serviceFailure, suggestView } from '#lib/server/api/present.ts';
import type { RequestHandler } from './$types';

/** What could be opened in a folder, without opening anything, for the chooser. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const directory = parseAbsolutePath(url.searchParams.get('directory') ?? '');
	if (!directory.ok) return badRequest('the folder is not a full path');
	const suggested = await locals.daemon.service.suggest(directory.value);
	if (!suggested.ok) return serviceFailure(suggested.error);
	const body: SuggestResponse = suggestView(suggested.value);
	return Response.json(body);
};
