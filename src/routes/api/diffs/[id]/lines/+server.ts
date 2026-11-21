import { LinesQuerySchema, type LinesView } from '#lib/api/schemas.ts';
import { resolveEscapedPath } from '#lib/core/path-bytes.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * Lines of a file of the version the page shows, as diff delver saved them, for
 * the unchanged lines a part opens. The repository itself is not read.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, LinesQuerySchema);
	if (!query.ok) return query.error;
	const { version, side, path, first, last } = query.value;
	const repoPath = resolveEscapedPath(path);
	if (repoPath === undefined) return unknownPath();
	const read = await locals.daemon.service.readLines(
		id.value,
		version,
		side,
		repoPath,
		first,
		last
	);
	if (!read.ok) return serviceFailure(read.error);
	const body: LinesView = { lines: [...read.value.lines], lineCount: read.value.lineCount };
	return Response.json(body);
};
