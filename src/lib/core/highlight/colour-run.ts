/**
 * Code coloured by language (DESIGN 8.3), as the page receives it: for each
 * line, the runs of its text that are a keyword, a string, a comment and so
 * on, each by where it starts and how long it is. Text in no run is drawn in
 * the page's own text colour.
 *
 * The kinds are few on purpose: enough to make code easier to read, each with
 * a colour that keeps its contrast on every background the page draws code
 * on. Comments are also set in italics, so they stand apart without colour.
 */
import type { CharacterCount } from '../character-count.tiny.ts';

/** What a run of code is, as the page colours it. */
export const TOKEN_KINDS = [
	'keyword',
	'string',
	'comment',
	'function',
	'constant',
	'parameter'
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

/** A run of a line's text: `length` characters from `start`, as JavaScript counts them. */
export interface ColourRun {
	readonly start: CharacterCount;
	readonly length: CharacterCount;
	readonly kind: TokenKind;
}
