import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatLineRanges, parseLineRange, type LineRange } from '../line-range.ts';
import { formatUnitSpec, parseLineSpec, parseUnitSpec } from './line-spec.ts';

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

describe('parseUnitSpec', () => {
	it('reads `file` for the file-level unit, alone or among ranges', () => {
		expect(parseUnitSpec('file')).toEqual({ ok: true, value: { ranges: [], file: true } });
		expect(parseUnitSpec(' file , +3..+4')).toEqual({
			ok: true,
			value: { ranges: [range('new', 3, 4)], file: true }
		});
		expect(parseUnitSpec('-2')).toEqual({
			ok: true,
			value: { ranges: [range('old', 2, 2)], file: false }
		});
	});

	it('names the whole value when a part cannot be read', () => {
		expect(parseUnitSpec('file,,+3')).toEqual({
			ok: false,
			error: { kind: 'MalformedLines', text: 'file,,+3', part: '', problem: 'empty' }
		});
		expect(parseLineSpec('file')).toMatchObject({ ok: false, error: { problem: 'unreadable' } });
	});

	it('reads back whatever formatUnitSpec writes', () => {
		const spec = { ranges: [range('old', 1, 2), range('new', 5, 5)], file: true };
		expect(parseUnitSpec(formatUnitSpec(spec))).toEqual({ ok: true, value: spec });
		expect(formatUnitSpec({ ranges: [], file: true })).toBe('file');
	});
});
