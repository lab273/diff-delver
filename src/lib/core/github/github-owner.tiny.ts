import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * A GitHub account, a person's or an organisation's, as it names a
 * repository's owner: `octo-org`. GitHub compares them in any case. It goes
 * into the address git fetches from (`gitHubCloneAddress`), so it is never
 * more than GitHub allows in an account's name; a pull request's author,
 * which may be one of GitHub's own `[bot]` accounts, is a `GitHubAuthor`.
 */
export type GitHubOwner = Tiny<string, 'GitHubOwner'>;

export interface InvalidGitHubOwner {
	readonly kind: 'InvalidGitHubOwner';
	readonly value: string;
}

/**
 * Accepts what GitHub allows in an account's name: letters, digits and
 * hyphens, not starting with a hyphen, at most 39 characters.
 */
export function parseGitHubOwner(value: string): Result<GitHubOwner, InvalidGitHubOwner> {
	return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value)
		? ok(value as GitHubOwner)
		: err({ kind: 'InvalidGitHubOwner', value });
}
