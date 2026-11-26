import { MarkReviewedRequestSchema, type Marked } from '#lib/api/schemas.ts';
import { resolveEscapedPath } from '#lib/core/path-bytes.ts';
import type { ReviewTarget } from '#lib/server/reports/index.ts';
import { markedView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody, unknownPath } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * Marks a part, a file or a group of the version the page shows as reviewed, or
 * not. When the diff was updated since, nothing is marked and the answer says
 * so (409), so a tick never lands on a version the reviewer has not seen.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const body = await readBody(request, MarkReviewedRequestSchema);
	if (!body.ok) return body.error;
	const { version, target, reviewed, view } = body.value;
	let resolved: ReviewTarget;
	switch (target.kind) {
		case 'slice':
		case 'file': {
			const path = resolveEscapedPath(target.path);
			if (path === undefined) return unknownPath();
			resolved =
				target.kind === 'slice'
					? { kind: 'slice', group: target.group, path, step: target.step ?? undefined }
					: { kind: 'file', path };
			break;
		}
		case 'group':
			resolved = { kind: 'group', group: target.group };
			break;
	}
	const service = locals.daemon.service;
	const sorting = target.kind === 'file' ? undefined : target.sorting;
	const marked = await service.markReviewed(id.value, version, resolved, reviewed, view, sorting);
	if (!marked.ok) return serviceFailure(marked.error);
	const loaded = await service.load(id.value, version);
	if (!loaded.ok) return serviceFailure(loaded.error);
	const answer: Marked = markedView(loaded.value, view, marked.value.files, marked.value.progress);
	return Response.json(answer);
};
