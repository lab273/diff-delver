import type { AgentSorting } from '#lib/api/schemas.ts';
import { agentSortingView } from '#lib/server/api/agent-sorting.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * How to have a coding agent sort this Delve: asked for when the person opens
 * the instructions on its page, never with the page. Reading it needs no more
 * than reading the Delve does, so a browser let in by an agent's link may.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const listed = locals.daemon.service.list();
	if (!listed.ok) return serviceFailure(listed.error);
	const report = listed.value.find((r) => r.kind === 'report' && r.id === id.value);
	if (report?.kind !== 'report')
		return serviceFailure({ kind: 'ReportNotFound', report: id.value });
	const body: AgentSorting = await agentSortingView(locals.daemon, report);
	return Response.json(body, { headers: { 'cache-control': 'no-store' } });
};
