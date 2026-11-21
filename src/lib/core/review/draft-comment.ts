import type { LineNumber } from '#lib/core/line-number.tiny.ts';
import type { RepoPath } from '#lib/core/repo-path.tiny.ts';
import type { RevisionNumber } from '#lib/core/revision-number.tiny.ts';
import type { Side } from '#lib/core/side.tiny.ts';

export const MAX_COMMENT_LENGTH = 10_000;

/** A contiguous range in one side of a specific snapshot file. */
export interface CommentAnchor {
	readonly path: RepoPath;
	readonly side: Side;
	readonly first: LineNumber;
	readonly last: LineNumber;
}

export interface DraftComment {
	readonly id: number;
	readonly version: RevisionNumber;
	readonly anchor: CommentAnchor;
	readonly body: string;
}
