import type { Stopping } from '#lib/api/schemas.ts';
import type { RequestHandler } from './$types';

/** Stops the daemon once this answer is sent: `diff-delver stop`. */
export const POST: RequestHandler = ({ locals }) => {
	locals.daemon.requestStop();
	const body: Stopping = { stopping: true };
	return Response.json(body);
};
