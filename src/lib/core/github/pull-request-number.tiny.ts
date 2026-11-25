import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/** A pull request's number within its repository: the 123 of `#123`. */
export type PullRequestNumber = Tiny<number, 'PullRequestNumber'>;

export interface InvalidPullRequestNumber {
	readonly kind: 'InvalidPullRequestNumber';
	readonly value: number;
}

/** Accepts a positive whole number. */
export function parsePullRequestNumber(
	value: number
): Result<PullRequestNumber, InvalidPullRequestNumber> {
	return Number.isSafeInteger(value) && value >= 1
		? ok(value as PullRequestNumber)
		: err({ kind: 'InvalidPullRequestNumber', value });
}
