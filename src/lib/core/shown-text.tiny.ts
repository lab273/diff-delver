import type { Tiny } from './tiny.ts';

/**
 * What a finding shows of the text it found: safe to print, because a secret is masked before it becomes one.
 *
 * A label, not a checked value: any text may be one, and the type records what
 * the text is, so it cannot be passed where another kind of text is meant.
 */
export type ShownText = Tiny<string, 'ShownText'>;

/** Marks text as safe to print, after any secret in it is masked. */
export function shownText(text: string): ShownText {
	return text as ShownText;
}
