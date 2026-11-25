import { err, ok, type Result } from '../result.ts';
import type { Tiny } from '../tiny.ts';

/**
 * A pull request's title, as GitHub gives it and a Delve keeps it: one line of
 * well-formed text of at most `PULL_REQUEST_TITLE_LENGTH` characters. Text from
 * GitHub, so it is shown with what cannot be seen written out.
 */
export type PullRequestTitle = Tiny<string, 'PullRequestTitle'>;

/** GitHub's own limit on a title. */
export const PULL_REQUEST_TITLE_LENGTH = 256;

export interface InvalidPullRequestTitle {
	readonly kind: 'InvalidPullRequestTitle';
	readonly value: string;
}

/** The first `PULL_REQUEST_TITLE_LENGTH` characters of `text`, never cutting one in half, and whether it has more. */
function firstCharacters(text: string): { readonly kept: string; readonly more: boolean } {
	let kept = '';
	let count = 0;
	for (const character of text) {
		if (count === PULL_REQUEST_TITLE_LENGTH) return { kept, more: true };
		kept += character;
		count += 1;
	}
	return { kept, more: false };
}

/** Accepts one line of well-formed text, possibly empty, of at most `PULL_REQUEST_TITLE_LENGTH` characters. */
export function parsePullRequestTitle(
	value: string
): Result<PullRequestTitle, InvalidPullRequestTitle> {
	const valid = !/[\n\r\0]/.test(value) && value.isWellFormed() && !firstCharacters(value).more;
	return valid ? ok(value as PullRequestTitle) : err({ kind: 'InvalidPullRequestTitle', value });
}

/**
 * Any text as a title: line breaks and NUL become spaces, text that is not
 * well formed is made so, and only the first `PULL_REQUEST_TITLE_LENGTH`
 * characters are kept.
 */
export function pullRequestTitleOf(value: string): PullRequestTitle {
	const line = value.toWellFormed().replaceAll(/[\n\r\0]/g, ' ');
	return firstCharacters(line).kept as PullRequestTitle;
}
