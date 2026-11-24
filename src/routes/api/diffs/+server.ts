import type { DiffList } from '#lib/api/schemas.ts';
import { listedView, serviceFailure } from '#lib/server/api/present.ts';
import { listedRepositories } from '#lib/server/api/repositories.ts';
import type { RequestHandler } from './$types';

/** Every diff, most recently active first, and the repositories they are of. */
export const GET: RequestHandler = async ({ locals }) => {
	const listed = locals.daemon.service.list();
	if (!listed.ok) return serviceFailure(listed.error);
	const diffs = listed.value.map(listedView);
	const body: DiffList = {
		now: locals.daemon.clock.now(),
		diffs,
		repositories: await listedRepositories(diffs)
	};
	return Response.json(body);
};
