import type { EntryCodeResponse } from '#lib/api/schemas.ts';
import type { RequestHandler } from './$types';

/**
 * A new single-use code that lets a browser in, for the address the command
 * opens, so the daemon's token is never on a command line (DESIGN 9).
 */
export const POST: RequestHandler = ({ locals }) => {
	const body: EntryCodeResponse = { code: locals.daemon.entryCode() };
	return Response.json(body);
};
