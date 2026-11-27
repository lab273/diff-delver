/**
 * Where a pull request is read on GitHub, `https://github.com/owner/name/pull/7`:
 * the link a Delve of it shows. Always made from the pull request's identity,
 * never taken from an answer of GitHub's, so a page links only to GitHub's own
 * address for it.
 */
import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';
import { parsePullRequestUrl, pullRequestUrl, type PullRequestRef } from './pull-request.ts';

export type PullRequestAddress = Tiny<string, 'PullRequestAddress'>;

export interface InvalidPullRequestAddress {
	readonly kind: 'InvalidPullRequestAddress';
	readonly text: string;
}

/** The pull request's address. */
export function pullRequestAddress(ref: PullRequestRef): PullRequestAddress {
	return pullRequestUrl(ref) as PullRequestAddress;
}

/** Reads back an address `pullRequestAddress` made, in exactly that form. */
export function parsePullRequestAddress(
	text: string
): Result<PullRequestAddress, InvalidPullRequestAddress> {
	const ref = parsePullRequestUrl(text);
	return ref.ok && pullRequestUrl(ref.value) === text
		? ok(text as PullRequestAddress)
		: err({ kind: 'InvalidPullRequestAddress', text });
}
