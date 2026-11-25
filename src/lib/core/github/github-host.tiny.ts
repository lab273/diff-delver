import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/** The host a GitHub repository is on, lowercase, such as `github.com`. */
export type GitHubHost = Tiny<string, 'GitHubHost'>;

export interface InvalidGitHubHost {
	readonly kind: 'InvalidGitHubHost';
	readonly value: string;
}

/** The one host diff delver knows the API of so far. */
export const GITHUB_COM = 'github.com' as GitHubHost;

/** Accepts a host name of lowercase letters, digits, dots and hyphens, as a URL gives it. */
export function parseGitHubHost(value: string): Result<GitHubHost, InvalidGitHubHost> {
	const valid = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(
		value
	);
	return valid && value.length <= 253
		? ok(value as GitHubHost)
		: err({ kind: 'InvalidGitHubHost', value });
}
