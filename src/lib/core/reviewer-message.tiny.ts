import type { Tiny } from './tiny.ts';

/**
 * A message for the reviewer, in plain words: what happened and what to do next
 * (docs/DEVELOPING.md, "Strong typing"). Any text is valid, so making one checks nothing; the
 * type records that the text was written for a person reading the page.
 */
export type ReviewerMessage = Tiny<string, 'ReviewerMessage'>;

/** Marks text written for the reviewer. */
export function reviewerMessage(text: string): ReviewerMessage {
	return text as ReviewerMessage;
}
