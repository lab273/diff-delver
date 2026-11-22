import { FileReaderQuerySchema } from '#lib/api/schemas.ts';
import { resolveEscapedPath } from '#lib/core/path-bytes.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * One page of a file in the pinned snapshot, with its change marks.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, FileReaderQuerySchema);
	if (!query.ok) return query.error;
	const { version, side, path, first, last } = query.value;
	const repoPath = resolveEscapedPath(path);
	if (repoPath === undefined) return unknownPath();
	const read = await locals.daemon.service.readFile(id.value, version, side, repoPath, first, last);
	if (!read.ok) return serviceFailure(read.error);
	return Response.json(read.value);
};
