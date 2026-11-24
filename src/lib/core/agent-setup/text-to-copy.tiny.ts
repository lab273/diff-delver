import type { Tiny } from '../tiny.ts';

/**
 * Text a page offers to copy: a command for a terminal, an entry for an agent's
 * settings, or a sentence to paste to an agent. A label, not a checked value:
 * the type records that the text was written to be pasted somewhere else, so it
 * is exact (paths quoted as its destination needs) and is shown as it is.
 */
export type TextToCopy = Tiny<string, 'TextToCopy'>;

/** Marks text written to be copied. */
export function textToCopy(text: string): TextToCopy {
	return text as TextToCopy;
}
