import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * What lets diff delver ask GitHub for a person's private repositories: a
 * token from `gh auth token` or `GITHUB_TOKEN`. A secret: it goes only into
 * the header of a request to GitHub, and never onto a command line, into a
 * log, an error, the database or a page.
 */
export type GitHubToken = Tiny<string, 'GitHubToken'>;

export interface InvalidGitHubToken {
	readonly kind: 'InvalidGitHubToken';
}

/** Accepts printable ASCII with no space, at most 1,000 characters: what a header can carry. */
export function parseGitHubToken(value: string): Result<GitHubToken, InvalidGitHubToken> {
	// The value is never put in the error, so a near miss is not written out anywhere.
	return /^[\x21-\x7e]{1,1000}$/.test(value)
		? ok(value as GitHubToken)
		: err({ kind: 'InvalidGitHubToken' });
}
