import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/** A pull request review's id on GitHub, the number GitHub gives it when it is posted. */
export type GitHubReviewId = Tiny<number, 'GitHubReviewId'>;

export interface InvalidGitHubReviewId {
	readonly kind: 'InvalidGitHubReviewId';
	readonly value: number;
}

/** Accepts a positive whole number. */
export function parseGitHubReviewId(value: number): Result<GitHubReviewId, InvalidGitHubReviewId> {
	return Number.isSafeInteger(value) && value >= 1
		? ok(value as GitHubReviewId)
		: err({ kind: 'InvalidGitHubReviewId', value });
}
