import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * How many times a draft comment's words have been changed since it was
 * written: zero or more. A page says the count it read when it changes or
 * deletes the comment, so a change made from another tab since is noticed and
 * never overwritten unseen.
 */
export type EditCount = Tiny<number, 'EditCount'>;

export interface InvalidEditCount {
	readonly kind: 'InvalidEditCount';
	readonly value: number;
}

export function parseEditCount(value: number): Result<EditCount, InvalidEditCount> {
	if (!Number.isSafeInteger(value) || value < 0) return err({ kind: 'InvalidEditCount', value });
	return ok(value as EditCount);
}

/** No change yet: the count of words as first written, or of an overall review never written. */
export const NO_EDITS = 0 as EditCount;
