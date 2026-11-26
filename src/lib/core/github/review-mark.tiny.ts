import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * The secret part of the mark a review diff delver posts carries (DESIGN
 * 8.6): 32 lowercase hex digits, made for each post from the `IdSource`,
 * random for the daemon and counted for tests and journeys, and kept with
 * the note of the post. Anyone can read a posted review's text, so the mark
 * of the next is never known before it is posted, and a review planted with
 * a guessed mark is not taken for one's own.
 */
export type ReviewMark = Tiny<string, 'ReviewMark'>;

export interface InvalidReviewMark {
	readonly kind: 'InvalidReviewMark';
	readonly value: string;
}

export function parseReviewMark(value: string): Result<ReviewMark, InvalidReviewMark> {
	if (!/^[0-9a-f]{32}$/.test(value)) return err({ kind: 'InvalidReviewMark', value });
	return ok(value as ReviewMark);
}
