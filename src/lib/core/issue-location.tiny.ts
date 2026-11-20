import type { Tiny } from './tiny.ts';

/**
 * Where in an export of the issue tracker a finding is: the issue's id, or `line N` of the export when the record has none.
 *
 * A label, not a checked value: any text may be one, and the type records what
 * the text is, so it cannot be passed where another kind of text is meant.
 */
export type IssueLocation = Tiny<string, 'IssueLocation'>;

/** Marks text as where in the issue data a finding is. */
export function issueLocation(text: string): IssueLocation {
	return text as IssueLocation;
}
