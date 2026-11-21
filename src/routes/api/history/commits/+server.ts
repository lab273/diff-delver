import { CommitsQuerySchema, type CommitsView } from '#lib/api/schemas.ts';
import { commitsView, serviceFailure } from '#lib/server/api/present.ts';
import { readQuery } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** A page of a branch's commits, newest first, each with its size. Only reads the repository. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const query = readQuery(url, CommitsQuerySchema);
	if (!query.ok) return query.error;
	const { directory, branch, from } = query.value;
	const page = await locals.daemon.service.commits(directory, branch, from);
	if (!page.ok) return serviceFailure(page.error);
	const body: CommitsView = commitsView(page.value);
	return Response.json(body);
};
