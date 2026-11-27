/**
 * The review routes' half of the API: a finished review as the API gives it,
 * the Delve's history and one past review (DESIGN 6.4), and what the routes
 * say to a browser that may not finish or read reviews.
 */
import type {
	DelveHistoryView,
	FinishedReviewView,
	JustFinishedView,
	PastReviewView
} from '#lib/api/schemas.ts';
import { ReviewNumberInAddressSchema } from '#lib/api/schemas.ts';
import { err, ok, type Result } from '#lib/core/result.ts';
import { reviewerMessage } from '#lib/core/reviewer-message.tiny.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import {
	describeArrival,
	describeDeliveries,
	describeHeld,
	describeItemKind,
	describeToday,
	reviewItems,
	startedBy,
	timelineOf
} from '#lib/core/reports/timeline.ts';
import type { ReviewNumber } from '#lib/core/review-number.tiny.ts';
import type { CommentAnchor } from '#lib/core/review/draft-comment.ts';
import type { FinishedReview, Handover } from '#lib/core/review/review-export.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';
import type { DaemonContext } from '#lib/server/daemon/context.ts';
import type { DelveHistory, JustFinished } from '#lib/server/reports/index.ts';
import { canReview, reviewSessionRequired } from './review-session.ts';
import { failure } from './present.ts';

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

function anchorView(anchor: CommentAnchor): PastReviewView['items'][number]['anchor'] {
	return { ...anchor, path: escapedRepoPath(anchor.path) };
}

/** The Delve's history as its page shows it: versions and reviews in order, in words. */
export function historyView(history: DelveHistory, now: Timestamp): DelveHistoryView {
	return {
		now,
		title: history.summary.title,
		version: history.summary.revision,
		entries: timelineOf(history.versions, history.reviews).map((entry) =>
			entry.kind === 'version'
				? {
						kind: 'version',
						version: entry.version.number,
						arrivedAt: entry.version.arrivedAt,
						text: describeArrival(entry.version)
					}
				: {
						kind: 'review',
						review: reviewView(entry.review),
						held: describeHeld(entry.review, history.threads),
						deliveries: [...describeDeliveries(entry.review, now)],
						today: describeToday(startedBy(history.threads, entry.review.number)) ?? null
					}
		)
	};
}

/** One past review as its page shows it; undefined when the Delve has no such review. */
export function pastReviewView(
	history: DelveHistory,
	number: ReviewNumber,
	now: Timestamp
): PastReviewView | undefined {
	const review = history.reviews.find((r) => r.number === number);
	if (review === undefined) return undefined;
	const { items, resolutions } = reviewItems(history.threads, number);
	return {
		now,
		title: history.summary.title,
		current: history.summary.revision,
		latest: history.reviews.at(-1)?.number ?? number,
		review: reviewView(review),
		held: describeHeld(review, history.threads),
		deliveries: [...describeDeliveries(review, now)],
		items: items.map((item) => ({
			kind: describeItemKind(item),
			version: item.version,
			anchor: anchorView(item.anchor),
			body: item.body,
			status: item.status
		})),
		resolutions: resolutions.map((r) => ({
			resolved: r.resolved,
			from: r.from ?? null,
			anchor: r.anchor === undefined ? null : anchorView(r.anchor),
			status: r.status
		}))
	};
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
