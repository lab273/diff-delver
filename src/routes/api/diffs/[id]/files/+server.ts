import { FileSearchQuerySchema } from '#lib/api/schemas.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readQuery } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const query = readQuery(url, FileSearchQuerySchema);
	if (!query.ok) return query.error;
	const found = await locals.daemon.service.searchFiles(
		id.value,
		query.value.version,
		query.value.name
	);
	return found.ok ? Response.json(found.value) : serviceFailure(found.error);
};
