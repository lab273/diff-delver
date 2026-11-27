import {
	RequestActionSchema,
	type RequestAction,
	type RequestsChangedView
} from '#lib/api/schemas.ts';
import type { AgentRequestId } from '#lib/core/agent-request-id.tiny.ts';
import { resolveEscapedPath } from '#lib/core/path-bytes.ts';
import type { ReportId } from '#lib/core/report-id.tiny.ts';
import type { DraftComment } from '#lib/core/review/draft-comment.ts';
import { PRIVATE, commentView, draftsRefused } from '#lib/server/api/comments.ts';
import { requestsView, serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody, unknownPath } from '#lib/server/api/request.ts';
import type { RequestAbout } from '#lib/server/reports/index.ts';
import type { RequestHandler } from './$types';

/**
 * The reviewer's questions for the agent (DESIGN 7.2), from a page that shows
 * the Delve's current version: asks one about lines, a file or a section,
 * cancels one no agent has answered, or promotes an answered one into the
 * draft. Like a comment, each needs a browser that may write the draft.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const refused = draftsRefused(locals.daemon, request);
	if (refused !== undefined) return refused;
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const parsed = await readBody(request, RequestActionSchema);
	if (!parsed.ok) return parsed.error;
	const action = parsed.value;
	const service = locals.daemon.service;
	switch (action.action) {
		case 'ask': {
			const about = aboutOf(action.about);
			if (about === undefined) return unknownPath();
			const asked = await service.askAgent(id.value, action.version, about, action.question);
			return asked.ok ? answer(locals, id.value, asked.value.id) : serviceFailure(asked.error);
		}
		case 'cancel': {
			const done = service.cancelRequest(id.value, action.version, action.request);
			return done.ok ? answer(locals, id.value) : serviceFailure(done.error);
		}
		case 'promote': {
			const done = await service.promoteRequest(id.value, action.version, action.request);
			return done.ok ? answer(locals, id.value, null, done.value) : serviceFailure(done.error);
		}
	}
};

function aboutOf(
	about: Extract<RequestAction, { action: 'ask' }>['about']
): RequestAbout | undefined {
	if (about.kind === 'section') return about;
	const path = resolveEscapedPath(about.path);
	return path === undefined ? undefined : { ...about, path };
}

function answer(
	locals: App.Locals,
	id: ReportId,
	asked: AgentRequestId | null = null,
	comment?: DraftComment
): Response {
	const service = locals.daemon.service;
	const requests = service.requests(id);
	if (!requests.ok) return serviceFailure(requests.error);
	const summary = service.summary(id);
	if (!summary.ok) return serviceFailure(summary.error);
	const body: RequestsChangedView = {
		requests: requestsView(requests.value, {
			id,
			title: summary.value.title,
			repository: summary.value.repository
		}),
		asked,
		comment: comment === undefined ? null : commentView(comment)
	};
	return Response.json(body, { headers: PRIVATE });
}
