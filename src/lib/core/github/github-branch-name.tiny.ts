import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * A branch as GitHub names it on a pull request, `feature-x`, without
 * `refs/heads/`. Text from GitHub, shown with what cannot be seen written out.
 */
export type GitHubBranchName = Tiny<string, 'GitHubBranchName'>;

export interface InvalidGitHubBranchName {
	readonly kind: 'InvalidGitHubBranchName';
	readonly value: string;
}

/**
 * Accepts a name git could have made a branch with: not empty, at most 255
 * characters, well formed, with no control character or space, not starting
 * with `-`, and without `..`.
 */
export function parseGitHubBranchName(
	value: string
): Result<GitHubBranchName, InvalidGitHubBranchName> {
	let control = false;
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f) control = true;
	}
	const valid =
		value !== '' &&
		value.length <= 255 &&
		!control &&
		!value.startsWith('-') &&
		!value.includes('..') &&
		value.isWellFormed();
	return valid ? ok(value as GitHubBranchName) : err({ kind: 'InvalidGitHubBranchName', value });
}
