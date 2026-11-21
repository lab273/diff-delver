/**
 * When a file is too much to colour (DESIGN 8.3), and is shown plain: it is
 * large, or looks generated or minified, where colours help little and
 * working them out would hold up everything else. The same for every file,
 * so a file is coloured, or not, the same way every time.
 */

/** A file of more than this many bytes is shown plain. */
export const MOST_BYTES_TO_COLOUR = 1_000_000;

/** A file of more lines than this is shown plain. */
export const MOST_LINES_TO_COLOUR = 30_000;

/** A file whose lines are this long on average looks minified, and is shown plain. */
export const LONGEST_AVERAGE_LINE = 300;

/** A line longer than this is shown plain, and the lines around it are still coloured. */
export const LONGEST_LINE_TO_COLOUR = 2_000;

/** Why a file whose language is known is shown plain, or undefined when it can be coloured. */
export function tooMuchToColour(bytes: number, lines: number): 'large' | 'minified' | undefined {
	if (bytes > MOST_BYTES_TO_COLOUR || lines > MOST_LINES_TO_COLOUR) return 'large';
	if (lines > 0 && bytes / lines > LONGEST_AVERAGE_LINE) return 'minified';
	return undefined;
}
