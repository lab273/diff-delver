import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * The tag GitHub gives an answer (its `ETag` header, such as `W/"6b2f…"`),
 * sent back as `If-None-Match` to ask whether anything has changed since.
 */
export type GitHubEtag = Tiny<string, 'GitHubEtag'>;

export interface InvalidGitHubEtag {
	readonly kind: 'InvalidGitHubEtag';
}

/** Accepts a header's worth of visible ASCII, at most 200 characters, as a tag. */
export function parseGitHubEtag(value: string): Result<GitHubEtag, InvalidGitHubEtag> {
	return /^[\x21-\x7e]{1,200}$/.test(value)
		? ok(value as GitHubEtag)
		: err({ kind: 'InvalidGitHubEtag' });
}
