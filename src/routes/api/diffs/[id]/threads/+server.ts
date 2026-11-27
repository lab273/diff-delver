import { ThreadActionSchema, type ThreadsChangedView } from '#lib/api/schemas.ts';
import { PRIVATE, commentView, draftsRefused } from '#lib/server/api/comments.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * The reviewer acts on a thread of an earlier review (DESIGN 6.3) from a page
 * that shows the Delve's current version: replies to it, resolves it, opens
 * it again, or takes back what the draft did to it. Each is part of the
 * draft, so it needs a browser that may write it.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const refused = draftsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const parsed = await readBody(request, ThreadActionSchema);
	if (!parsed.ok) return parsed.error;
	const action = parsed.value;
	const service = locals.daemon.service;
	if (action.action === 'reply') {
		const saved = await service.replyToThread(id.value, action.version, action.thread, action.body);
		if (!saved.ok) return serviceFailure(saved.error);
		const resolutions = service.draftResolutions(id.value);
		if (!resolutions.ok) return serviceFailure(resolutions.error);
		return answer({ resolutions: [...resolutions.value], comment: commentView(saved.value) }, 201);
	}
	const resolved =
		action.action === 'resolve' ? true : action.action === 'reopen' ? false : undefined;
	const done = await service.resolveThread(id.value, action.version, action.thread, resolved);
	return done.ok
		? answer({ resolutions: [...done.value], comment: null }, 200)
		: serviceFailure(done.error);
};

function answer(body: ThreadsChangedView, status: number): Response {
	return Response.json(body, { status, headers: PRIVATE });
}
