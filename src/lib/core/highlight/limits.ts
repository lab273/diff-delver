/**
 * When a file is too much to colour (DESIGN 8.3), and is shown plain: it is
 * large, or looks generated or minified, where colours help little and
 * working them out would hold up everything else. The same for every file,
 * so a file is coloured, or not, the same way every time.
 */
import type { Language } from './language.ts';

/** A file of more than this many bytes is shown plain. */
export const MOST_BYTES_TO_COLOUR = 1_000_000;

/** A file of more lines than this is shown plain. */
export const MOST_LINES_TO_COLOUR = 30_000;

/** A file whose lines are this long on average looks minified, and is shown plain. */
export const LONGEST_AVERAGE_LINE = 300;

/**
 * A line longer than this is shown plain, and the lines around it are still
 * coloured. A line is coloured in one go, so this is what bounds the longest
 * time the daemon gives to colouring before it answers anything else: at this
 * length the slowest line found for any grammar here, of characters chosen to
 * make it slow, took about 40 ms on a laptop (`highlighter.limits.test.ts`).
 */
export const LONGEST_LINE_TO_COLOUR = 1_000;

/**
 * The grammars whose worst lines grow much faster with their length, with a
 * lower limit of their own that keeps them to about the same time: in a shell
 * script, a line of 1,000 `<` took 300 ms and one of 2,000 more than two
 * seconds; in Svelte, a line of 1,000 `` `${ `` took 95 ms; in C++, one of
 * 1,000 `<a /*` took 58 ms.
 */
const LONGEST_LINE_FOR: Partial<Readonly<Record<Language, number>>> = {
	cpp: 800,
	shellscript: 500,
	svelte: 600
};

/** The longest line of `language` that is coloured; a longer one is plain, every time. */
export function longestLineToColour(language: Language): number {
	return LONGEST_LINE_FOR[language] ?? LONGEST_LINE_TO_COLOUR;
}

/** Why a file whose language is known is shown plain, or undefined when it can be coloured. */
export function tooMuchToColour(bytes: number, lines: number): 'large' | 'minified' | undefined {
	if (bytes > MOST_BYTES_TO_COLOUR || lines > MOST_LINES_TO_COLOUR) return 'large';
	if (lines > 0 && bytes / lines > LONGEST_AVERAGE_LINE) return 'minified';
	return undefined;
}
