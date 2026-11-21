import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countIn, findIn, foldCase, searchedForm } from './find-text.ts';
import { parseSearchText } from './search-text.tiny.ts';

describe('finding text', () => {
	it('finds each match where it starts, without overlapping, as a browser does', () => {
		expect(findIn('aaaa', 'aa', true)).toEqual([
			{ start: 0, length: 2 },
			{ start: 2, length: 2 }
		]);
		expect(findIn('a total, Total, TOTAL', 'total', false).map((m) => m.start)).toEqual([2, 9, 16]);
		expect(findIn('a total, Total, TOTAL', 'total', true).map((m) => m.start)).toEqual([2]);
		expect(findIn('nothing', 'x', false)).toEqual([]);
	});

	it('folds only A to Z, so every character keeps its place', () => {
		expect(foldCase('ÉCOLE École İstanbul ABC')).toBe('École École İstanbul abc');
		fc.assert(
			fc.property(fc.string({ unit: 'binary' }), (text) => {
				expect(foldCase(text).length).toBe(text.length);
			})
		);
	});

	it('counts what it finds', () => {
		fc.assert(
			fc.property(
				fc.string(),
				fc.string({ minLength: 1, maxLength: 3 }),
				fc.boolean(),
				(text, q, c) => {
					const query = searchedForm(q, c);
					expect(countIn(text, query, c)).toBe(findIn(text, query, c).length);
				}
			)
		);
	});

	it('takes plain text on one line, never empty', () => {
		expect(parseSearchText('lex(').ok).toBe(true);
		expect(parseSearchText('-e --all').ok).toBe(true);
		expect(parseSearchText('')).toEqual({
			ok: false,
			error: { kind: 'InvalidSearchText', reason: 'empty' }
		});
		expect(parseSearchText('a\nb').ok).toBe(false);
		expect(parseSearchText('a\0b').ok).toBe(false);
		expect(parseSearchText('x'.repeat(501)).ok).toBe(false);
	});
});
