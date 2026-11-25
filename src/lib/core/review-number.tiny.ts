import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A submitted review's place within its report: 1, 2, 3, as the reviewer and
 * the agent see it ("review 2"). A report's reviews are numbered in the order
 * they were finished (DESIGN 6.3).
 */
export type ReviewNumber = Tiny<number, 'ReviewNumber'>;

export interface InvalidReviewNumber {
	readonly kind: 'InvalidReviewNumber';
	readonly value: number;
}

/** Accepts a positive whole number. */
export function parseReviewNumber(value: number): Result<ReviewNumber, InvalidReviewNumber> {
	if (!Number.isSafeInteger(value) || value < 1) {
		return err({ kind: 'InvalidReviewNumber', value });
	}
	return ok(value as ReviewNumber);
}

/** The number the next review of a report takes, after `latest`, or the first when there is none. */
export function nextReviewNumber(latest: ReviewNumber | undefined): ReviewNumber {
	return ((latest ?? 0) + 1) as ReviewNumber;
}
