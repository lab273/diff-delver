import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseLineText, type LineText } from '../line-text.tiny.ts';
import { linePieces, type LinePiece } from './line-pieces.ts';

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
});
