import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * A branch as git names it in full: a local branch, `refs/heads/feature-x`, or
 * a remote-tracking branch, `refs/remotes/origin/feature-x`. Always starts with
 * `refs/`, so git never reads one as an option, and has no `..`, so it is a
 * revision that can be one end of a range.
 */
export type BranchRef = Tiny<string, 'BranchRef'>;

export interface InvalidBranchRef {
	readonly kind: 'InvalidBranchRef';
	readonly value: string;
}

const PREFIXES = ['refs/heads/', 'refs/remotes/'] as const;

/** A control character, a space, or one of the characters git refuses in a ref name. */
function hasForbiddenCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(value.charAt(i))) return true;
	}
	return false;
}

/**
 * Accepts a full branch name as `git for-each-ref` prints it: one of the two
 * prefixes and a name after it, with no control character, space, `..`, or any
 * character git does not allow in a ref (`~ ^ : ? * [ \`), well-formed text.
 */
export function parseBranchRef(value: string): Result<BranchRef, InvalidBranchRef> {
	const prefix = PREFIXES.find((p) => value.startsWith(p));
	const name = prefix === undefined ? '' : value.slice(prefix.length);
	const valid =
		name !== '' &&
		value.isWellFormed() &&
		!value.includes('..') &&
		!value.includes('@{') &&
		!value.endsWith('/') &&
		!value.endsWith('.lock') &&
		!value.includes('//') &&
		!hasForbiddenCharacter(value);
	return valid ? ok(value as BranchRef) : err({ kind: 'InvalidBranchRef', value });
}

/** Whether a branch is a remote-tracking one, such as `origin/feature-x`. */
export function isRemoteBranch(branch: BranchRef): boolean {
	return branch.startsWith('refs/remotes/');
}

/** The branch as people name it: `feature-x` for a local branch, `origin/feature-x` for a remote one. */
export function branchName(branch: BranchRef): string {
	return branch.slice(isRemoteBranch(branch) ? 'refs/remotes/'.length : 'refs/heads/'.length);
}
