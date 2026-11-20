import type { StateChange } from '#lib/api/schemas.ts';
import { serviceFailure, summaryView } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** Reopens a closed diff, unless another diff of the same changes is open. */
export const POST: RequestHandler = ({ locals, params }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const changed = locals.daemon.service.reopenReport(id.value);
	if (!changed.ok) return serviceFailure(changed.error);
	const body: StateChange = { diff: summaryView(changed.value) };
	return Response.json(body);
};
