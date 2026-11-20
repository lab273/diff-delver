import { OpenRequestSchema, type OpenResponse } from '#lib/api/schemas.ts';
import {
	describeInvalidSourceSpec,
	parseGitSourceSpec
} from '#lib/core/sources/git-source-spec.ts';
import { failure, openView, serviceFailure } from '#lib/server/api/present.ts';
import { readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** Opens one source in a folder: resumes its open diff, or makes a new one. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await readBody(request, OpenRequestSchema);
	if (!body.ok) return body.error;
	const spec = parseGitSourceSpec(body.value.source);
	if (!spec.ok) return failure(422, spec.error.kind, describeInvalidSourceSpec(spec.error));
	const opened = await locals.daemon.service.open(body.value.directory, spec.value);
	if (!opened.ok) return serviceFailure(opened.error);
	const response: OpenResponse = openView(opened.value);
	return Response.json(response);
};
