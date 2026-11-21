import { PartQuerySchema, type PartLines } from '#lib/api/schemas.ts';
import { resolveEscapedPath } from '#lib/core/path-bytes.ts';
import { partLinesView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** One part's lines, of the version the page shows, from diff delver's copy of the diff. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, PartQuerySchema);
	if (!query.ok) return query.error;
	const { version, view, group, path } = query.value;
	const repoPath = resolveEscapedPath(path);
	if (repoPath === undefined) return unknownPath();
	const part = await locals.daemon.service.readPart(id.value, version, view, group, repoPath);
	if (!part.ok) return serviceFailure(part.error);
	const body: PartLines = partLinesView(part.value);
	return Response.json(body);
};
