/**
 * The review routes' half of the API: a finished review as the API gives it,
 * and what the routes say to a browser that may not finish or read reviews.
 */
import type { FinishedReviewView } from '#lib/api/schemas.ts';
import type { FinishedReview } from '#lib/core/review/review-export.ts';
import type { DaemonContext } from '#lib/server/daemon/context.ts';
import { canReview, reviewSessionRequired } from './review-session.ts';

export function reviewView(review: FinishedReview): FinishedReviewView {
	return {
		number: review.number,
		version: review.version,
		submittedAt: review.submittedAt,
		comments: review.comments,
		overall: review.overall,
		progress: review.progress,
		text: review.text
	};
}

/** The refusal for a browser that was let in by a link, or undefined when it may. */
export function reviewsRefused(daemon: DaemonContext, request: Request): Response | undefined {
	return canReview(daemon, request)
		? undefined
		: reviewSessionRequired('finish or read reviews', 'comments');
}
