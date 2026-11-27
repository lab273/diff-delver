import { SummaryReadRequestSchema, type SummaryRead } from '#lib/api/schemas.ts';
import { serviceFailure } from '#lib/server/api/present.ts';
import { diffId, readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * The reviewer has read the agent's overview, or a section's summary, as the
 * version the page shows has it (DESIGN 8.1). Any version the Delve has: the
 * text read is that version's, and it is read in every version that has it.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const id = diffId(params.id);
	if (!id.ok) return id.error;
	const body = await readBody(request, SummaryReadRequestSchema);
	if (!body.ok) return body.error;
	const read = locals.daemon.service.markSummaryRead(
		id.value,
		body.value.version,
		body.value.place
	);
	if (!read.ok) return serviceFailure(read.error);
	const answer: SummaryRead = { read: read.value };
	return Response.json(answer);
};
