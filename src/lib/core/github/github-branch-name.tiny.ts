import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * A branch as GitHub names it on a pull request, `feature-x`, without
 * `refs/heads/`. Text from GitHub, shown with what cannot be seen written out.
 * It goes into a refspec (`refs/heads/<name>`), so it is held to git's rules.
 */
export type GitHubBranchName = Tiny<string, 'GitHubBranchName'>;

export interface InvalidGitHubBranchName {
	readonly kind: 'InvalidGitHubBranchName';
	readonly value: string;
}

/** A control character, a space, or one of the characters git refuses in a ref name. */
function hasForbiddenCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(value.charAt(i))) return true;
	}
	return false;
}

/**
 * Accepts a name git could have made a branch with, by `git check-ref-format
 * --branch`'s rules: not empty, at most 255 characters, well formed, not `@`,
 * not starting with `-`; no control character, space or any of `~ ^ : ? * [
 * \`; no `..` or `@{`; no `/` at either end or twice in a row; no part
 * starting with `.` or ending with `.lock`; and not ending with `.`.
 */
export function parseGitHubBranchName(
	value: string
): Result<GitHubBranchName, InvalidGitHubBranchName> {
	const parts = value.split('/');
	const valid =
		value !== '' &&
		value.length <= 255 &&
		value.isWellFormed() &&
		value !== '@' &&
		!value.startsWith('-') &&
		!hasForbiddenCharacter(value) &&
		!value.includes('..') &&
		!value.includes('@{') &&
		!value.endsWith('.') &&
		parts.every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
	return valid ? ok(value as GitHubBranchName) : err({ kind: 'InvalidGitHubBranchName', value });
}
