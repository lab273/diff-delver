import { HistoryQuerySchema, type HistoryView } from '#lib/api/schemas.ts';
import { historyView, serviceFailure } from '#lib/server/api/present.ts';
import { readQuery } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** A repository's branches and when it last fetched, for choosing what to review. Only reads it. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const query = readQuery(url, HistoryQuerySchema);
	if (!query.ok) return query.error;
	const found = await locals.daemon.service.branches(query.value.directory, query.value.find);
	if (!found.ok) return serviceFailure(found.error);
	const body: HistoryView = historyView(found.value, locals.daemon.clock.now());
	return Response.json(body);
};
