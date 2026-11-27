import type { Storage } from '#lib/api/schemas.ts';
import { serviceFailure, storageView } from '#lib/server/api/present.ts';
import type { RequestHandler } from './$types';

/** What diff delver takes on disk: the database, and each store with its Delves (DESIGN 9.1). */
export const GET: RequestHandler = async ({ locals }) => {
	const storage = await locals.daemon.service.storage();
	if (!storage.ok) return serviceFailure(storage.error);
	const body: Storage = storageView(storage.value);
	return Response.json(body);
};
