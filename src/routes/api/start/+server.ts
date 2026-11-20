import { StartRequestSchema, type StartResponse } from '#lib/api/schemas.ts';
import { serviceFailure, startView } from '#lib/server/api/present.ts';
import { readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** What `diff-delver` with no arguments does in a folder: opens the likely source, or says what to choose. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await readBody(request, StartRequestSchema);
	if (!body.ok) return body.error;
	const started = await locals.daemon.service.start(body.value.directory);
	if (!started.ok) return serviceFailure(started.error);
	const response: StartResponse = startView(started.value);
	return Response.json(response);
};
