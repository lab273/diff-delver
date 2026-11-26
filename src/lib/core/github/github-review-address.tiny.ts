/**
 * Where a review posted to a pull request is read on GitHub: the review
 * itself, `https://github.com/owner/name/pull/7#pullrequestreview-123`, or,
 * for a review left as a draft, the pull request's changes, where the
 * reviewer submits it, `https://github.com/owner/name/pull/7/files`. Always
 * made from the pull request and the review's id, never taken from an answer
 * of GitHub's, so a page links only to GitHub's own address for it.
 */
import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';
import type { GitHubReviewId } from './github-review-id.tiny.ts';
import { pullRequestUrl, type PullRequestRef } from './pull-request.ts';

export type GitHubReviewAddress = Tiny<string, 'GitHubReviewAddress'>;

export interface InvalidGitHubReviewAddress {
	readonly kind: 'InvalidGitHubReviewAddress';
	readonly text: string;
}

/** The address of a review: of the review, or, for a draft, of the changes it is submitted from. */
export function gitHubReviewAddress(
	pullRequest: PullRequestRef,
	review: GitHubReviewId,
	draft: boolean
): GitHubReviewAddress {
	const pull = pullRequestUrl(pullRequest);
	return (
		draft ? `${pull}/files` : `${pull}#pullrequestreview-${String(review)}`
	) as GitHubReviewAddress;
}

/** Reads an address `gitHubReviewAddress` made back, as stored. */
export function parseGitHubReviewAddress(
	text: string
): Result<GitHubReviewAddress, InvalidGitHubReviewAddress> {
	return /^https:\/\/[a-z0-9.-]+\/[^/\s#?]+\/[^/\s#?]+\/pull\/[1-9][0-9]*(\/files|#pullrequestreview-[1-9][0-9]*)$/.test(
		text
	)
		? ok(text as GitHubReviewAddress)
		: err({ kind: 'InvalidGitHubReviewAddress', text });
}
