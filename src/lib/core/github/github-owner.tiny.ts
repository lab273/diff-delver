import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * A GitHub account, a person's or an organisation's, as it names a repository's
 * owner or a pull request's author: `octo-org`. GitHub compares them in any case.
 */
export type GitHubOwner = Tiny<string, 'GitHubOwner'>;

export interface InvalidGitHubOwner {
	readonly kind: 'InvalidGitHubOwner';
	readonly value: string;
}

/**
 * Accepts what GitHub allows in an account's name: letters, digits and hyphens,
 * not starting with a hyphen, at most 39 characters; and, for the accounts
 * GitHub runs itself, such as `dependabot[bot]`, a `[bot]` at the end.
 */
export function parseGitHubOwner(value: string): Result<GitHubOwner, InvalidGitHubOwner> {
	return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(value)
		? ok(value as GitHubOwner)
		: err({ kind: 'InvalidGitHubOwner', value });
}
