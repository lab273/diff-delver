import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { DaemonContext } from '#lib/server/daemon/context.ts';
import { failure } from './present.ts';

/** The browser's review grant, through the cookie path of the Origin gate. */
export function canReview(daemon: DaemonContext, request: Request): boolean {
	return (
		!request.headers.has('authorization') &&
		daemon.isReviewBrowser(request.headers.get('cookie') ?? undefined)
	);
}

/**
 * The answer to a browser that may read and tick but not do `action`: it was
 * let in by a link, such as an agent's, and not by a window diff delver opened.
 * It names the button on the page that asked: the one for `what`.
 */
export function reviewSessionRequired(action: string, what: 'comments' | 'deleting'): Response {
	return failure(
		403,
		'BrowserSessionRequired',
		reviewerMessage(
			`This browser was let in by a link, which is not enough to ${action}, so nothing was changed. Reload this page and press “Turn on ${what} in this browser”.`
		)
	);
}
