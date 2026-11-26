import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * The GitHub account that opened a pull request: a person's, such as
 * `octo`, or one GitHub runs itself, such as `dependabot[bot]`.
 */
export type GitHubAuthor = Tiny<string, 'GitHubAuthor'>;

export interface InvalidGitHubAuthor {
	readonly kind: 'InvalidGitHubAuthor';
	readonly value: string;
}

/**
 * Accepts an account's name as GitHub allows it (letters, digits and
 * hyphens, not starting with a hyphen, at most 39 characters), with a
 * `[bot]` at the end for the accounts GitHub runs itself. Only an author
 * may have one: no repository is owned by such an account.
 */
export function parseGitHubAuthor(value: string): Result<GitHubAuthor, InvalidGitHubAuthor> {
	return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(value)
		? ok(value as GitHubAuthor)
		: err({ kind: 'InvalidGitHubAuthor', value });
}
