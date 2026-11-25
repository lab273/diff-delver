import { OpenRequestSchema, type OpenResponse } from '#lib/api/schemas.ts';
import { describeInvalidSource, parseSourceSpec } from '#lib/core/sources/source-spec.ts';
import { failure, openView, serviceFailure } from '#lib/server/api/present.ts';
import { readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/** Opens one source in a folder, a git source or a pull request: resumes its open diff, or makes a new one. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const body = await readBody(request, OpenRequestSchema);
	if (!body.ok) return body.error;
	const spec = parseSourceSpec(body.value.source);
	if (!spec.ok) return failure(422, spec.error.kind, describeInvalidSource(spec.error));
	const opened = await locals.daemon.service.open(body.value.directory, spec.value);
	if (!opened.ok) return serviceFailure(opened.error);
	const response: OpenResponse = openView(opened.value);
	return Response.json(response);
};
