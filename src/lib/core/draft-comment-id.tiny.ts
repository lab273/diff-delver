import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * One draft comment, as the database numbers it: a whole number of 1 or more,
 * never used again once the comment is deleted.
 */
export type DraftCommentId = Tiny<number, 'DraftCommentId'>;

export interface InvalidDraftCommentId {
	readonly kind: 'InvalidDraftCommentId';
	readonly value: number;
}

export function parseDraftCommentId(value: number): Result<DraftCommentId, InvalidDraftCommentId> {
	if (!Number.isSafeInteger(value) || value < 1) {
		return err({ kind: 'InvalidDraftCommentId', value });
	}
	return ok(value as DraftCommentId);
}
