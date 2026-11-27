/**
 * The review routes' half of the API: a finished review as the API gives it,
 * and what the routes say to a browser that may not finish or read reviews.
 */
import type { FinishedReviewView, JustFinishedView } from '#lib/api/schemas.ts';
import { ReviewNumberInAddressSchema } from '#lib/api/schemas.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import type { ReviewNumber } from '#lib/core/review-number.tiny.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import type { FinishedReview, Handover } from '#lib/core/review/review-export.ts';
import type { DaemonContext } from '#lib/server/daemon/context.ts';
import type { JustFinished } from '#lib/server/reports/index.ts';
import { failure } from './present.ts';
import { canReview, reviewSessionRequired } from './review-session.ts';

function handoverView(handover: Handover | undefined): FinishedReviewView['copied'] {
	return handover === undefined
		? null
		: { times: handover.times, first: handover.first, last: handover.last };
}

export function reviewView(review: FinishedReview): FinishedReviewView {
	return {
		number: review.number,
		version: review.version,
		submittedAt: review.submittedAt,
		comments: review.comments,
		flags: review.flags,
		overall: review.overall,
		progress: review.progress,
		text: review.text,
		posted:
			review.posted === undefined
				? null
				: {
						as: review.posted.postedAs,
						address: review.posted.address,
						inText: review.posted.inText,
						at: review.posted.at
					},
		copied: handoverView(review.copied),
		read: handoverView(review.read)
	};
}

/** A review just finished, with whether it is one an earlier post had put on GitHub. */
export function justFinishedView(review: JustFinished): JustFinishedView {
	return { ...reviewView(review), earlier: review.earlier ?? null };
}

/** The review an address names; one that names none is a review that is not there (404). */
export function reviewNumberIn(text: string | undefined): Result<ReviewNumber, Response> {
	const number = ReviewNumberInAddressSchema.safeParse(text ?? '');
	return number.success
		? ok(number.data)
		: err(
				failure(404, 'ReviewNotFound', reviewerMessage('There is no such review of this Delve.'))
			);
}

/** The refusal for a browser that was let in by a link, or undefined when it may. */
export function reviewsRefused(daemon: DaemonContext, request: Request): Response | undefined {
	return canReview(daemon, request)
		? undefined
		: reviewSessionRequired('finish or read reviews', 'comments');
}
