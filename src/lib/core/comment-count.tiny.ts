import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A number of comments, such as those of a finished review. */
export type CommentCount = Tiny<number, 'CommentCount'>;

export interface InvalidCommentCount {
	readonly kind: 'InvalidCommentCount';
	readonly value: number;
}

/** Accepts zero or a positive whole number. */
export function parseCommentCount(value: number): Result<CommentCount, InvalidCommentCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidCommentCount', value });
	return ok(value as CommentCount);
}

/** The count of comments in a list, which is always a count. */
export function commentCountOf(value: number): CommentCount {
	const parsed = parseCommentCount(value);
	if (!parsed.ok) throw new RangeError(`Not a comment count: ${String(value)}`);
	return parsed.value;
}
