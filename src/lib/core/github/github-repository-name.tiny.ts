import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/** A repository's name on GitHub, without its owner and without `.git`: `diff-delver`. */
export type GitHubRepositoryName = Tiny<string, 'GitHubRepositoryName'>;

export interface InvalidGitHubRepositoryName {
	readonly kind: 'InvalidGitHubRepositoryName';
	readonly value: string;
}

/**
 * Accepts what GitHub allows in a repository's name: letters, digits, `.`, `_`
 * and `-`, at most 100 characters, neither `.` nor `..`, and not ending in
 * `.git`, which a clone's address adds.
 */
export function parseGitHubRepositoryName(
	value: string
): Result<GitHubRepositoryName, InvalidGitHubRepositoryName> {
	const valid =
		/^[A-Za-z0-9._-]{1,100}$/.test(value) &&
		value !== '.' &&
		value !== '..' &&
		!value.toLowerCase().endsWith('.git');
	return valid
		? ok(value as GitHubRepositoryName)
		: err({ kind: 'InvalidGitHubRepositoryName', value });
}
