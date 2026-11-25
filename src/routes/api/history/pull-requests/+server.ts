import { PullRequestsRequestSchema, type PullRequestsView } from '#lib/api/schemas.ts';
import { pullRequestsView, serviceFailure } from '#lib/server/api/present.ts';
import { readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * The repository's open pull requests, asked of GitHub: a network call made
 * only when a person opens the list, never with the page. Writes nothing.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await readBody(request, PullRequestsRequestSchema);
	if (!body.ok) return body.error;
	const listed = await locals.daemon.service.pullRequests(body.value.directory);
	if (!listed.ok) return serviceFailure(listed.error);
	const response: PullRequestsView = pullRequestsView(listed.value, locals.daemon.clock.now());
	return Response.json(response);
};
