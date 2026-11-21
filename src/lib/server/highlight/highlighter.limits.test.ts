/**
 * What keeps colouring from holding up the daemon (DESIGN 8.3): a line longer
 * than its language's limit is plain every time, a slice never holds much
 * more than one long line, and other work runs between slices. The slowest
 * lines found for the heavy grammars, at their limits, are timed against the
 * guidance in `limits.ts`, as a warning when over it.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGES, type Language } from '#lib/core/highlight/language.ts';
import { LONGEST_LINE_TO_COLOUR, longestLineToColour } from '#lib/core/highlight/limits.ts';
import { parseLineText, type LineText } from '#lib/core/line-text.tiny.ts';
import { measurementName } from '#lib/core/measurement-name.tiny.ts';
import { millisecondsOf } from '#lib/core/milliseconds.tiny.ts';
import { recordTime } from '../../../../tests/support/measured-time.ts';
import { now } from '../../../../tests/support/stopwatch.ts';
import { colourLines, sliceLength } from './highlighter.ts';

function line(text: string): LineText {
	const parsed = parseLineText(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

/** A line of `length` characters made of `unit`, which has something to colour. */
function lineOf(unit: string, length: number): LineText {
	return line(unit.repeat(Math.ceil(length / unit.length)).slice(0, length));
}

/** The slowest lines found for the grammars that are slowest, and the most time one may take. */
const SLOWEST: readonly { readonly language: Language; readonly unit: string }[] = [
	{ language: 'shellscript', unit: '<' },
	{ language: 'cpp', unit: '<a /*' },
	{ language: 'svelte', unit: '`${' },
	{ language: 'markdown', unit: '>>>' },
	{ language: 'typescript', unit: '$' },
	{ language: 'vue', unit: 'template<' }
];
const GUIDANCE_MS = 60;

describe('colouring that never holds up the daemon for long', () => {
	it('colours a line as long as its language’s limit, and leaves a longer one plain, every time', async () => {
		for (const language of LANGUAGES) {
			const longest = longestLineToColour(language);
			expect(longest).toBeLessThanOrEqual(LONGEST_LINE_TO_COLOUR);
			const fits = lineOf('"x" ', longest);
			const over = lineOf('"x" ', longest + 1);
			const [short] = await colourLines([line('"x" ')], language);
			for (let pass = 0; pass < 2; pass += 1) {
				const [coloured, plain] = await colourLines([fits, over, fits], language);
				expect({ language, plain }).toEqual({ language, plain: [] });
				// Coloured whenever the same text, short, has colour in this language.
				expect({ language, coloured: (coloured ?? []).length > 0 }).toEqual({
					language,
					coloured: (short ?? []).length > 0
				});
			}
		}
	});

	it('ends a slice once it holds a long line’s worth of characters', () => {
		const short = line('a'.repeat(10));
		const long = line('a'.repeat(LONGEST_LINE_TO_COLOUR));
		expect(sliceLength([short, short, short], 0, 16)).toBe(3);
		expect(sliceLength([short, short, short], 1, 1)).toBe(1);
		expect(sliceLength([long, short, short], 0, 16)).toBe(1);
		expect(sliceLength([short, long, long, long], 0, 16)).toBe(2);
		expect(sliceLength([short, short], 2, 16)).toBe(0);
	});

	it('lets other work run between slices of a large file', async () => {
		const file = Array.from({ length: 3_000 }, (_, i) => line(`const a${String(i)} = "x";`));
		await colourLines(file.slice(0, 1), 'typescript');
		let turns = 0;
		let colouring = true;
		const count = (): void => {
			turns += 1;
			if (colouring) setImmediate(count);
		};
		setImmediate(count);
		await colourLines(file, 'typescript');
		colouring = false;
		expect(turns).toBeGreaterThan(3);
	});

	it('colours the slowest lines found within the guidance', async ({ task }) => {
		for (const { language, unit } of SLOWEST) {
			const slow = lineOf(unit, longestLineToColour(language));
			// The first line of a grammar also prepares it, once; that is not what is timed.
			await colourLines([slow], language);
			const started = now();
			const coloured = await colourLines([slow], language);
			recordTime(
				task,
				measurementName(`colouring the slowest ${language} line found`),
				millisecondsOf(now() - started),
				millisecondsOf(GUIDANCE_MS)
			);
			expect(coloured).toHaveLength(1);
		}
	});
});
