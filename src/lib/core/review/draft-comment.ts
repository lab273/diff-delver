import type { DraftCommentId } from '#lib/core/draft-comment-id.tiny.ts';
import type { EditCount } from '#lib/core/edit-count.tiny.ts';
import type { LineNumber } from '#lib/core/line-number.tiny.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import type { Side } from '#lib/core/side.tiny.ts';
import type { ThreadId } from '#lib/core/thread-id.tiny.ts';
import type { Timestamp } from '#lib/core/timestamp.tiny.ts';

export const MAX_COMMENT_LENGTH = 10_000;

/** A contiguous range in one side of a specific snapshot file. */
export interface CommentAnchor {
	readonly path: RepoPath;
	readonly side: Side;
	readonly first: LineNumber;
	readonly last: LineNumber;
}

/**
 * What a thread of the draft is (DESIGN 5): a comment, the reviewer's words on
 * lines, or a flag, their one-press "look at this again" on lines, whose
 * words are optional.
 */
export type ThreadKind = 'comment' | 'flag';

/**
 * One comment or flag of the reviewer's private draft (DESIGN 6.3): their own
 * mark on lines of the version they made it on. Its lines never change once
 * it is saved; its words can be edited until the review is handed over.
 */
export interface DraftComment {
	readonly id: DraftCommentId;
	readonly kind: ThreadKind;
	readonly version: RevisionNumber;
	readonly anchor: CommentAnchor;
	readonly body: string;
	readonly writtenAt: Timestamp;
	/** When its words were last changed; undefined while they are as first written. */
	readonly editedAt: Timestamp | undefined;
	/** How many times its words have been changed. */
	readonly edits: EditCount;
	/**
	 * The thread from an earlier review it replies to (DESIGN 6.3), on that
	 * thread's lines; undefined for a comment of the reviewer's own.
	 */
	readonly replyTo: ThreadId | undefined;
}

/** Whether `body` can be saved as a comment's words: something written, and not too long. */
export function isCommentBody(body: string): boolean {
	return body.trim() !== '' && body.length <= MAX_COMMENT_LENGTH;
}

/**
 * Whether `body` can be saved as the words of a thread of `kind`: a comment's
 * as `isCommentBody` says, a flag's anything not too long, none at all too.
 */
export function isThreadBody(kind: ThreadKind, body: string): boolean {
	switch (kind) {
		case 'comment':
			return isCommentBody(body);
		case 'flag':
			return body.length <= MAX_COMMENT_LENGTH;
	}
}

/** A flag's words as stored: as typed, or none when they are only white space. */
export function storedThreadBody(kind: ThreadKind, body: string): string {
	return kind === 'flag' && body.trim() === '' ? '' : body;
}

/**
 * A comment's lines in words, as the page says them: "Before, line 4",
 * "After, lines 3–5". The side is named as the diff's columns are.
 */
export function describeCommentLines(
	anchor: Pick<CommentAnchor, 'side' | 'first' | 'last'>
): string {
	const side = anchor.side === 'old' ? 'Before' : 'After';
	return anchor.first === anchor.last
		? `${side}, line ${String(anchor.first)}`
		: `${side}, lines ${String(anchor.first)}–${String(anchor.last)}`;
}
