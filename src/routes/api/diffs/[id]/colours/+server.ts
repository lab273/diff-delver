import { ColoursQuerySchema, type ColoursView } from '#lib/api/schemas.ts';
import { resolveEscapedPath } from '#lib/core/path-bytes.ts';
import { coloursView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * The colours of lines of a file of the version the page shows, by language,
 * worked out from the whole file as diff delver saved it. The page shows the
 * lines plain until they come.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, ColoursQuerySchema);
	if (!query.ok) return query.error;
	const { version, path, old, new: now } = query.value;
	const repoPath = resolveEscapedPath(path);
	if (repoPath === undefined) return unknownPath();
	const read = await locals.daemon.service.readColours(id.value, version, repoPath, {
		old,
		new: now
	});
	if (!read.ok) return serviceFailure(read.error);
	const body: ColoursView = coloursView(read.value);
	return Response.json(body);
};
