import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatLineRanges, parseLineRange, type LineRange } from '../line-range.ts';
import { parseLineSpec } from './line-spec.ts';

const range = (side: 'old' | 'new', first: number, last: number): LineRange => {
	const parsed = parseLineRange(side, first, last);
	if (!parsed.ok) throw new Error('bad test range');
	return parsed.value;
};

describe('parseLineSpec', () => {
	it('reads ranges and single lines on both sides', () => {
		expect(parseLineSpec('+40..+62,-38..-45, +7 ,-1')).toEqual({
			ok: true,
			value: [range('new', 40, 62), range('old', 38, 45), range('new', 7, 7), range('old', 1, 1)]
		});
	});

	it('accepts a range whose end has no sign', () => {
		expect(parseLineSpec('+3..5')).toEqual({ ok: true, value: [range('new', 3, 5)] });
	});

	it.each([
		['', '', 'empty'],
		['+1,,+3', '', 'empty'],
		['40..62', '40..62', 'unreadable'],
		['+a', '+a', 'unreadable'],
		['+3..-5', '+3..-5', 'mixed-sides'],
		['+5..+3', '+5..+3', 'bad-range'],
		['-0', '-0', 'bad-range']
	])('rejects %j', (text, part, problem) => {
		expect(parseLineSpec(text)).toEqual({
			ok: false,
			error: { kind: 'MalformedLines', text, part, problem }
		});
	});

	it('reads back whatever formatLineRanges writes', () => {
		const anyRange = fc
			.tuple(fc.boolean(), fc.integer({ min: 1, max: 10_000 }), fc.nat(50))
			.map(([isNew, first, width]) => range(isNew ? 'new' : 'old', first, first + width));
		fc.assert(
			fc.property(fc.array(anyRange, { minLength: 1, maxLength: 8 }), (ranges) => {
				expect(parseLineSpec(formatLineRanges(ranges))).toEqual({ ok: true, value: ranges });
			})
		);
	});
});
