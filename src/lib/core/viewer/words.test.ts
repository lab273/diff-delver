import { describe, expect, it } from 'vitest';
import { parseByteSize } from '../byte-size.tiny.ts';
import { unitCountOf } from '../unit-count.tiny.ts';
import { countOf, describeByteSize, describeTally, formatCount } from './words.ts';

function bytes(n: number) {
	const parsed = parseByteSize(n);
	if (!parsed.ok) throw new Error(String(n));
	return parsed.value;
}

function tally(units: number, reviewed: number) {
	return {
		units: unitCountOf(units),
		reviewed: unitCountOf(reviewed),
		fresh: unitCountOf(0),
		unmarked: unitCountOf(0)
	};
}

describe('the viewer’s words', () => {
	it('separates thousands', () => {
		expect([0, 7, 999, 1000, 12345, 200000, 1234567].map(formatCount)).toEqual([
			'0',
			'7',
			'999',
			'1,000',
			'12,345',
			'200,000',
			'1,234,567'
		]);
		expect(countOf(1, 'change', 'changes')).toBe('1 change');
		expect(countOf(4000, 'line', 'lines')).toBe('4,000 lines');
	});

	it('says how far a part has got', () => {
		expect(describeTally(tally(5, 0))).toBe('5 changes');
		expect(describeTally(tally(5, 2))).toBe('2 of 5 changes reviewed');
		expect(describeTally(tally(1, 1))).toBe('Reviewed');
		expect(describeTally(tally(0, 0))).toBe('Nothing to review');
	});

	it('gives sizes as GitHub does', () => {
		expect(
			[0, 1, 512, 1024, 1536, 10 * 1024, 5 * 1024 * 1024 + 1].map((n) => describeByteSize(bytes(n)))
		).toEqual(['0 bytes', '1 byte', '512 bytes', '1 KB', '1.5 KB', '10 KB', '5 MB']);
	});
});
