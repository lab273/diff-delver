import type { DaemonInfo } from '#lib/api/schemas.ts';
import type { RequestHandler } from './$types';

/** Which build the daemon runs, so the command can tell whether it can use it. */
export const GET: RequestHandler = ({ locals }) => {
	const body: DaemonInfo = { version: locals.daemon.version };
	return Response.json(body);
};
