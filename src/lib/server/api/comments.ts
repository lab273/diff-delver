/**
 * The comment routes' half of the API: a stored comment as the API gives it,
 * and what the routes say to a browser that may not read or write drafts.
 */
import type { DraftCommentView } from '#lib/api/schemas.ts';
import { escapedRepoPath } from '#lib/core/path-bytes.ts';
import type { DraftComment } from '#lib/core/review/draft-comment.ts';
import type { DaemonContext } from '#lib/server/daemon/context.ts';
import { canReview, reviewSessionRequired } from './review-session.ts';

export function commentView(comment: DraftComment): DraftCommentView {
	return {
		id: comment.id,
		version: comment.version,
		anchor: { ...comment.anchor, path: escapedRepoPath(comment.anchor.path) },
		body: comment.body,
		writtenAt: comment.writtenAt,
		editedAt: comment.editedAt ?? null,
		edits: comment.edits
	};
}

/** Drafts are the reviewer's alone: never kept by a browser or anything between. */
export const PRIVATE = { 'cache-control': 'no-store' };

/** The refusal for a browser that was let in by a link, or undefined when it may. */
export function draftsRefused(daemon: DaemonContext, request: Request): Response | undefined {
	return canReview(daemon, request)
		? undefined
		: reviewSessionRequired('read or change draft comments');
}
