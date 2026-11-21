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

export function reviewSessionRequired(action: string): Response {
	return failure(
		403,
		'BrowserSessionRequired',
		reviewerMessage(
			`To ${action}, run diff-delver in a terminal and open its link in this browser. Then reload this page.`
		)
	);
}
