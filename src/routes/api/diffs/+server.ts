import type { DiffList } from '#lib/api/schemas.ts';
import { listedView, serviceFailure } from '#lib/server/api/present.ts';
import type { RequestHandler } from './$types';

/** Every diff, most recently active first. */
export const GET: RequestHandler = ({ locals }) => {
	const listed = locals.daemon.service.list();
	if (!listed.ok) return serviceFailure(listed.error);
	const body: DiffList = { now: locals.daemon.clock.now(), diffs: listed.value.map(listedView) };
	return Response.json(body);
};
