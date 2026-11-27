/**
 * The comment routes' half of the API: a stored comment and the overall review as the API gives them,
 * and what the routes say to a browser that may not read or write drafts.
 */
import type { DraftCommentView, OverallReviewView } from '#lib/api/schemas.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import type { DraftComment } from '#lib/core/review/draft-comment.ts';
import type { OverallReview } from '#lib/core/review/overall-review.ts';
import type { DaemonContext } from '#lib/server/daemon/context.ts';
import { canReview, reviewSessionRequired } from './review-session.ts';

export function commentView(comment: DraftComment): DraftCommentView {
	return {
		id: comment.id,
		kind: comment.kind,
		version: comment.version,
		anchor: { ...comment.anchor, path: escapedRepoPath(comment.anchor.path) },
		body: comment.body,
		writtenAt: comment.writtenAt,
		editedAt: comment.editedAt ?? null,
		edits: comment.edits,
		replyTo: comment.replyTo ?? null
	};
}

export function overallReviewView(overall: OverallReview): OverallReviewView {
	return { body: overall.body, changedAt: overall.changedAt ?? null, edits: overall.edits };
}

/** Drafts are the reviewer's alone: never kept by a browser or anything between. */
export const PRIVATE = { 'cache-control': 'no-store' };

/** The refusal for a browser that was let in by a link, or undefined when it may. */
export function draftsRefused(daemon: DaemonContext, request: Request): Response | undefined {
	return canReview(daemon, request)
		? undefined
		: reviewSessionRequired('read or change draft comments', 'comments');
}
