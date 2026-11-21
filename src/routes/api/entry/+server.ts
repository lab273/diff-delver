import type { EntryCodeResponse } from '#lib/api/schemas.ts';
import { failure } from '#lib/server/api/present.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { RequestHandler } from './$types';

/**
 * A new single-use code that lets a browser in, for the address the command
 * opens, so the daemon's token is never on a command line (DESIGN 9).
 */
export const POST: RequestHandler = ({ locals, request }) => {
	if (!locals.daemon.isCommand(request.headers.get('authorization') ?? undefined)) {
		return failure(
			403,
			'CommandRequired',
			reviewerMessage('Run diff-delver in a terminal to open a new review session.')
		);
	}
	const body: EntryCodeResponse = { code: locals.daemon.entryCode() };
	return Response.json(body);
};
