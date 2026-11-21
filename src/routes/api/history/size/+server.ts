import { RunSizeQuerySchema, type RunSizeView } from '#lib/api/schemas.ts';
import { runSizeView, serviceFailure } from '#lib/server/api/present.ts';
import { readQuery } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** The size of the diff a run of commits makes. Only reads the repository. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const query = readQuery(url, RunSizeQuerySchema);
	if (!query.ok) return query.error;
	const { directory, from, to } = query.value;
	const size = await locals.daemon.service.runSize(directory, from, to);
	if (!size.ok) return serviceFailure(size.error);
	const body: RunSizeView = runSizeView(size.value);
	return Response.json(body);
};
