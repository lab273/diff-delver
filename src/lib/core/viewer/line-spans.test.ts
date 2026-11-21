import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineNumberOf } from '../line-number.tiny.ts';
import { linesIn, readSpans, spansOf, writeSpans } from './line-spans.ts';

describe('runs of lines in an address', () => {
	it('are written and read back', () => {
		const spans = spansOf([1, 2, 3, 7, 9, 10].map(lineNumberOf));
		expect(writeSpans(spans)).toBe('1-3,7,9-10');
		expect(readSpans('1-3,7,9-10')).toEqual({ ok: true, value: spans });
		expect(readSpans('')).toEqual({ ok: true, value: [] });
	});

	it('refuse anything else', () => {
		for (const text of ['0', '3-1', '1-3,2', 'a', '1,,2', '-1', '1-2-3']) {
			expect(readSpans(text).ok).toBe(false);
		}
	});

	it('hold the same lines however they were given', () => {
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 1, max: 300 })), (numbers) => {
				const spans = spansOf(numbers.map(lineNumberOf));
				expect([...linesIn(spans)]).toEqual([...new Set(numbers)].sort((a, b) => a - b));
				expect(readSpans(writeSpans(spans))).toEqual({ ok: true, value: spans });
			})
		);
	});
});
