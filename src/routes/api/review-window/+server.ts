import { ReviewWindowRequestSchema, type ReviewWindow } from '#lib/api/schemas.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { failure } from '#lib/server/api/present.ts';
import { readBody } from '#lib/server/api/request.ts';
import type { RequestHandler } from './$types';

/**
 * Opens a Delve, or the list of Delves, in the person's own browser, in a
 * window that may write their drafts: what a page offers when its browser was
 * let in by a link and so may only read and tick (DESIGN 9).
 *
 * Any of the daemon's pages may ask, whatever its grant, and that is safe
 * because of what the asker gets back: only whether a window was asked for.
 * The address with its single-use code goes to the system's opener and so to
 * the browser of the person at this machine (`openForReview` in `daemon.ts`).
 * An agent that got hold of a view link can make a window appear in front of
 * the person, at most one every few seconds; it cannot receive the grant. The request gate has already
 * required the daemon's own `Origin` and a cookie, and serves `/mcp` nothing
 * but MCP, so no tool reaches this. A program that brings the command's token
 * is not a browser and has its own way in (`/api/entry`), so it is refused.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (request.headers.has('authorization')) {
		return failure(
			403,
			'BrowserRequired',
			reviewerMessage(
				'Only a page of diff delver in a browser can ask for this. Run diff-delver in a terminal to open one.'
			)
		);
	}
	const parsed = await readBody(request, ReviewWindowRequestSchema);
	if (!parsed.ok) return parsed.error;
	const { diff } = parsed.value;
	const body: ReviewWindow = {
		outcome: await locals.daemon.openForReview(diff === null ? '/' : `/diffs/${diff}`)
	};
	return Response.json(body, { headers: { 'cache-control': 'no-store' } });
};
