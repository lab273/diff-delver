import { DiffSearchQuerySchema, type DiffSearchView } from '#lib/api/schemas.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * Searches the version the page shows for plain text, part by part: how many
 * matches each part has in its path and its lines, from diff delver's copy of
 * the diff. The repository itself is not read.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, DiffSearchQuerySchema);
	if (!query.ok) return query.error;
	const { version, view, text, matchCase, changedOnly, assignments } = query.value;
	const found = await locals.daemon.service.searchDiff(
		id.value,
		version,
		view,
		text,
		{
			matchCase,
			changedOnly
		},
		assignments
	);
	if (!found.ok) return serviceFailure(found.error);
	const body: DiffSearchView = {
		parts: found.value.map((p) => ({
			group: p.group,
			path: escapedRepoPath(p.path),
			matches: p.matches
		}))
	};
	return Response.json(body);
};
