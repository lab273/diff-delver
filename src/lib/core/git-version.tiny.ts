import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A git release, as its three numbers: `2.45.0`. Read from what `git --version`
 * prints, which may add a platform's suffix, as in `git version 2.39.3 (Apple
 * Git-146)` or `git version 2.45.1.windows.1`.
 */
export type GitVersion = Tiny<string, 'GitVersion'>;

export interface InvalidGitVersion {
	readonly kind: 'InvalidGitVersion';
	readonly text: string;
}

/** The version in `git --version`'s output, or in a plain `2.45.0`. */
export function parseGitVersion(text: string): Result<GitVersion, InvalidGitVersion> {
	const found = /^(?:git version )?(\d{1,5})\.(\d{1,5})(?:\.(\d{1,5}))?/.exec(text.trim());
	if (found === null) return err({ kind: 'InvalidGitVersion', text });
	const parts = [found[1], found[2], found[3] ?? '0'].map((part) => String(Number(part)));
	return ok(parts.join('.') as GitVersion);
}

function numbers(version: GitVersion): readonly number[] {
	return version.split('.').map(Number);
}

/** Whether `version` is `minimum` or a later release. */
export function isAtLeast(version: GitVersion, minimum: GitVersion): boolean {
	const have = numbers(version);
	const need = numbers(minimum);
	for (let i = 0; i < need.length; i += 1) {
		const a = have[i] ?? 0;
		const b = need[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

/**
 * The oldest git diff delver works with: 2.45.0, the first with
 * `GIT_NO_LAZY_FETCH`, which keeps git from downloading into a partial clone
 * that is being reviewed. Everything else it uses is older: `cat-file -Z`
 * (2.42), `--attr-source` (2.41), `check-attr --source` (2.40), `ls-files
 * --sparse` (2.35), `rev-parse --path-format` (2.31).
 */
export const MINIMUM_GIT_VERSION = '2.45.0' as GitVersion;
