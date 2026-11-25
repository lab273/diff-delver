import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * A pull request's description, as its author wrote it on GitHub: Markdown
 * that is given to an agent as text and never shown on a page as markup. Not
 * blank, well formed, at most `PULL_REQUEST_DESCRIPTION_LENGTH` characters.
 */
export type PullRequestDescription = Tiny<string, 'PullRequestDescription'>;

/** GitHub's own limit on a description. */
export const PULL_REQUEST_DESCRIPTION_LENGTH = 65_536;

export interface InvalidPullRequestDescription {
	readonly kind: 'InvalidPullRequestDescription';
}

/** Accepts well-formed text that is not blank, of at most `PULL_REQUEST_DESCRIPTION_LENGTH` units. */
export function parsePullRequestDescription(
	value: string
): Result<PullRequestDescription, InvalidPullRequestDescription> {
	const valid =
		value.trim() !== '' && value.isWellFormed() && value.length <= PULL_REQUEST_DESCRIPTION_LENGTH;
	return valid
		? ok(value as PullRequestDescription)
		: err({ kind: 'InvalidPullRequestDescription' });
}

/** Any text as a description: made well formed and cut to the limit; undefined when blank. */
export function pullRequestDescriptionOf(
	value: string | null | undefined
): PullRequestDescription | undefined {
	const text = (value ?? '')
		.toWellFormed()
		.slice(0, PULL_REQUEST_DESCRIPTION_LENGTH)
		.toWellFormed();
	return text.trim() === '' ? undefined : (text as PullRequestDescription);
}
