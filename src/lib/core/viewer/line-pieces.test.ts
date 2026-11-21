import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { characterCount } from '../character-count.tiny.ts';
import { TOKEN_KINDS, type ColourRun, type TokenKind } from '../highlight/colour-run.ts';
import { parseLineText, type LineText } from '../line-text.tiny.ts';
import { linePieces, type LinePiece } from './line-pieces.ts';

function run(start: number, length: number, kind: TokenKind): ColourRun {
	return { start: characterCount(start), length: characterCount(length), kind };
}

/** Runs in order and not overlapping, within a line of `length` characters. */
function runsWithin(length: number): fc.Arbitrary<readonly ColourRun[]> {
	return fc
		.array(fc.tuple(fc.nat({ max: length }), fc.constantFrom(...TOKEN_KINDS)), { maxLength: 6 })
		.map((cuts) => {
			const edges = [...new Set(cuts.map(([at]) => at))].sort((a, b) => a - b);
			const runs: ColourRun[] = [];
			for (let i = 0; i + 1 < edges.length; i += 2) {
				const start = edges[i] ?? 0;
				const end = edges[i + 1] ?? start;
				const kind = cuts[i]?.[1] ?? 'keyword';
				if (end > start) runs.push(run(start, end - start, kind));
			}
			return runs;
		});
}

function text(value: string): LineText {
	const parsed = parseLineText(value);
	if (!parsed.ok) throw new Error(value);
	return parsed.value;
}

/** The line again, from its pieces. */
function joined(pieces: readonly LinePiece[]): string {
	return pieces
		.map((p) => {
			switch (p.kind) {
				case 'text':
				case 'trailing':
					return p.text;
				case 'tab':
					return '\t';
				case 'escape':
					return p.character;
			}
		})
		.join('');
}

describe('a line in pieces', () => {
	it('keeps plain text, markup included, as text', () => {
		expect(linePieces(text('<b>not bold</b> &amp;'), true)).toEqual([
			{ kind: 'text', text: '<b>not bold</b> &amp;' }
		]);
	});

	it('marks tabs, white space at the end of a changed line, and a carriage return', () => {
		expect(linePieces(text('\tif (x)  \r'), true)).toEqual([
			{ kind: 'tab' },
			{ kind: 'text', text: 'if (x)' },
			{ kind: 'trailing', text: '  ' },
			{ kind: 'escape', shown: '\\r', character: '\r' }
		]);
		// A context line's tabs and trailing white space are left alone.
		expect(linePieces(text('\ta  '), false)).toEqual([{ kind: 'text', text: '\ta  ' }]);
	});

	it('shows what cannot be seen, or turns text round, by its code', () => {
		expect(linePieces(text('a\u0007b‮c​d﻿'), false)).toEqual([
			{ kind: 'text', text: 'a' },
			{ kind: 'escape', shown: '\\x07', character: '\u0007' },
			{ kind: 'text', text: 'b' },
			{ kind: 'escape', shown: '\\u202E', character: '‮' },
			{ kind: 'text', text: 'c' },
			{ kind: 'escape', shown: '\\u200B', character: '​' },
			{ kind: 'text', text: 'd' },
			{ kind: 'escape', shown: '\\uFEFF', character: '﻿' }
		]);
	});

	it('loses nothing: the pieces make the line again', () => {
		fc.assert(
			fc.property(
				fc.string({ unit: 'binary' }).map((s) => s.replaceAll('\n', '')),
				fc.boolean(),
				(line, trailing) => {
					expect(joined(linePieces(text(line), trailing))).toBe(line);
				}
			)
		);
	});

	it('colours text by its runs, leaving the rest plain', () => {
		expect(
			linePieces(text('const x = "a"; // b'), true, [
				run(0, 5, 'keyword'),
				run(10, 3, 'string'),
				run(15, 4, 'comment')
			])
		).toEqual([
			{ kind: 'text', text: 'const', colour: 'keyword' },
			{ kind: 'text', text: ' x = ' },
			{ kind: 'text', text: '"a"', colour: 'string' },
			{ kind: 'text', text: '; ' },
			{ kind: 'text', text: '// b', colour: 'comment' }
		]);
	});

	it('draws tabs, trailing white space and escapes as they are, over any colour', () => {
		expect(linePieces(text('\tx​y  \r'), true, [run(0, 7, 'string')])).toEqual([
			{ kind: 'tab' },
			{ kind: 'text', text: 'x', colour: 'string' },
			{ kind: 'escape', shown: '\\u200B', character: '\u200B' },
			{ kind: 'text', text: 'y', colour: 'string' },
			{ kind: 'trailing', text: '  ' },
			{ kind: 'escape', shown: '\\r', character: '\r' }
		]);
	});

	it('loses nothing and moves no mark when coloured', () => {
		fc.assert(
			fc.property(
				fc
					.string({ unit: 'binary', maxLength: 40 })
					.map((s) => s.replaceAll('\n', ''))
					.chain((line) => fc.tuple(fc.constant(line), runsWithin(line.length), fc.boolean())),
				([line, runs, changed]) => {
					const colouredPieces = linePieces(text(line), changed, runs);
					expect(joined(colouredPieces)).toBe(line);
					const marks = (pieces: readonly LinePiece[]) => pieces.filter((p) => p.kind !== 'text');
					expect(marks(colouredPieces)).toEqual(marks(linePieces(text(line), changed)));
				}
			)
		);
	});
});
