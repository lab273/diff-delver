import { RemoteCheckRequestSchema, type RemoteCheckView } from '#lib/api/schemas.ts';
import { remoteCheckView, serviceFailure } from '#lib/server/api/present.ts';
import { readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * Asks the repository's remotes what their branches are at and compares them
 * with what it last fetched: the one network call for a local repository,
 * made only when a person presses the button. Writes nothing.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await readBody(request, RemoteCheckRequestSchema);
	if (!body.ok) return body.error;
	const checked = await locals.daemon.service.checkRemotes(body.value.directory);
	if (!checked.ok) return serviceFailure(checked.error);
	const response: RemoteCheckView = remoteCheckView(checked.value);
	return Response.json(response);
};
